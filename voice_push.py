"""PSN push transport and Miranda voice messages."""
import asyncio
import base64
import binascii
import json
import re
import time

from wsproto import ConnectionType, WSConnection, events


PUSH_DISCOVERY = "https://mobile-pushcl.np.communication.playstation.net/np/serveraddr"
MOBILE_PLATFORM = 100001
PLATFORMS = {"MOBILE_APP": MOBILE_PLATFORM, "PS4": 5, "PS5": 5}
MAX_SDP = 65536
MAX_FRAME = 192 * 1024
PAYLOAD_PREFIX = "ver=1.0, type=binary, body="


def voice_payload(account, member, platform, description, sequence):
    sender = {"account_id": account, "platform": MOBILE_PLATFORM}
    recipient = {"account_id": member, "platform": PLATFORMS[platform]}
    message = {
        "from": sender, "global_seq_num": sequence + 1,
        "medias": [{"media_records": [{"media_identifier": "voice_chat", "mid": "0"}],
                    "msids": ["0"], "user": sender}],
        "sdp": description["sdp"], "sdp_sequence_number": description["sequence"],
        "to": recipient, "type": description["type"], "users": [sender, recipient],
    }
    body = b"1/1/1\n" + json.dumps(message, separators=(",", ":")).encode()
    header = (b"\x01" + bytes(7) + sequence.to_bytes(4, "little") + bytes(4)
              + int(account).to_bytes(8, "little") + MOBILE_PLATFORM.to_bytes(4, "little")
              + bytes(12) + len(body).to_bytes(4, "little"))
    return {
        "channel": "miranda:12", "payload": PAYLOAD_PREFIX + base64.b64encode(header + body).decode(),
        "to": [{"accountId": member, "platform": platform}], "withoutSequenceNumber": True,
    }


class VoiceMessageError(ValueError):
    """An incoming push message could not be used for the current voice session."""


def voice_description(frame, session, account):
    try:
        if ":customMessage:" not in frame["dataType"]:
            raise VoiceMessageError("not a custom-message event")
        data = frame["body"]["data"]
        if (data.get("sessionId") or data.get("partySessionId")) != session:
            raise VoiceMessageError("event session did not match")
        message = data.get("customMessage", data)
        if message.get("channel") != "miranda:12":
            raise VoiceMessageError("event is not on the voice channel")
        payload = message.get("payload")
        if not isinstance(payload, str) or len(payload) > MAX_FRAME:
            raise VoiceMessageError("unexpected voice payload type or size")
        payload = payload.removeprefix("payload=")
        if not payload.startswith(PAYLOAD_PREFIX):
            raise VoiceMessageError("unrecognized voice payload prefix")
        try:
            raw = base64.b64decode(payload[len(PAYLOAD_PREFIX):].strip(), validate=True)
        except (ValueError, binascii.Error):
            raise VoiceMessageError("invalid voice payload encoding") from None
        if raw[44:50] == b"1/1/1\n" and int.from_bytes(raw[40:44], "little") == len(raw) - 44:
            start = 50
            envelope_sender = str(int.from_bytes(raw[16:24], "little"))
        else:
            # For other header layouts, use the sender in the authenticated PSN event.
            sender_data = (data.get("customProperties") or {}).get("from") or {}
            if not sender_data.get("accountId"):
                raise VoiceMessageError("voice event did not include a sender")
            envelope_sender = str(sender_data["accountId"])
            match = re.search(rb'\{\s*"', raw[:256])
            if match is None:
                raise VoiceMessageError("unrecognized voice packet header")
            start = match.start()
        try:
            # A binary packet may carry padding or trailer bytes after the JSON.
            description, _ = json.JSONDecoder().raw_decode(raw[start:].decode("utf-8", errors="replace").lstrip())
        except ValueError:
            raise VoiceMessageError("voice packet did not contain decodable JSON") from None
        if not isinstance(description, dict):
            raise VoiceMessageError("voice description was not an object")
        kind, sdp = description.get("type"), description.get("sdp")
        error_code = str(description.get("p2p_error_code", ""))
        peer_failed = re.fullmatch(r"(?:-?[0-9]{1,12}|0x[0-9a-fA-F]{1,8})", error_code)
        if kind not in {"offer", "answer"} and not peer_failed:
            fields = sorted(key for key in description if re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]{0,31}", key))
            schema = ", ".join(fields[:16]) or "none"
            raise VoiceMessageError(f"message is not a voice offer or answer (JSON fields: {schema})")
        sender_field = description.get("from") or {}
        sender = str(sender_field.get("account_id") or sender_field.get("accountId") or envelope_sender)
        sequence = str(description.get("sdp_sequence_number"))
        recipient = description.get("to") or {}
        event_recipient = (frame.get("to") or {}).get("accountId")
        addressed_to = recipient.get("account_id") or recipient.get("accountId") or event_recipient
        if not addressed_to:
            raise VoiceMessageError("voice description did not include a recipient")
        if str(addressed_to) != account or (event_recipient and str(event_recipient) != account):
            raise VoiceMessageError("description was addressed to another player")
        if sender == account:
            raise VoiceMessageError("server echoed our outgoing description")
        if sender != envelope_sender:
            raise VoiceMessageError("description sender did not match the packet")
        if kind not in {"offer", "answer"}:
            return {"account": sender, "type": "error", "code": error_code}
        if not isinstance(sdp, str) or not sdp.startswith("v=0") or len(sdp) > MAX_SDP:
            raise VoiceMessageError("invalid voice session description")
        if not re.fullmatch(r"[0-9]{1,10}", sequence):
            raise VoiceMessageError("invalid voice sequence number")
        return {"account": sender, "type": kind, "sdp": sdp, "sequence": sequence}
    except VoiceMessageError:
        raise
    except (KeyError, TypeError, AttributeError, ValueError):
        raise VoiceMessageError("malformed voice event or description") from None


class VoicePush:
    def __init__(self):
        self.ws = WSConnection(ConnectionType.CLIENT)
        self.ready = asyncio.Event()
        self.frames = asyncio.Queue(maxsize=32)
        self.task = None

    async def connect(self, host, token, account, tls, version, keepalive_type, interval):
        if not re.fullmatch(r"(?:[a-z0-9-]+\.)*np\.communication\.playstation\.net", host):
            raise ValueError("Sony returned an unexpected push server.")
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, 443, ssl=tls), 8)
        self.task = asyncio.create_task(self._listen(reader, writer, host, token, account,
                                                     version, keepalive_type, interval))
        ready = asyncio.create_task(self.ready.wait())
        try:
            done, _ = await asyncio.wait({ready, self.task}, timeout=8, return_when=asyncio.FIRST_COMPLETED)
            if self.task in done:
                await self.task
                raise ValueError("Sony closed the voice signaling connection.")
            if ready not in done:
                raise ValueError("Sony did not acknowledge voice push authentication.")
        except BaseException:
            await self.close()
            raise
        finally:
            ready.cancel()

    async def _listen(self, reader, writer, host, token, account, version, keepalive_type, interval):
        def send(event):
            writer.write(self.ws.send(event))

        headers = {
            "origin": "https://m.np.playstation.com",
            "authorization": f"Bearer {token}",
            "x-psn-reconnection": "false",
            "x-psn-os-ver": "16",
            "x-psn-keep-alive-status-type": keepalive_type,
            "x-psn-protocol-version": version,
            "x-psn-app-type": "MOBILE_APP.PSAPP",
            "x-psn-app-ver": "26.1.0",
        }
        try:
            send(events.Request(host=host, target="/np/pushNotification", subprotocols=["np-pushpacket"],
                                extra_headers=[(key.encode(), value.encode()) for key, value in headers.items()]))
            await writer.drain()
            fragments = []
            size = 0
            auth_transaction = str(int(time.time() * 1000))
            next_ping = time.monotonic() + interval
            while True:
                try:
                    chunk = await asyncio.wait_for(reader.read(65536), max(0.1, next_ping - time.monotonic()))
                except asyncio.TimeoutError:
                    if not self.ready.is_set():
                        raise ValueError("Sony did not upgrade the voice signaling connection.")
                    send(events.Ping())
                    await writer.drain()
                    next_ping = time.monotonic() + interval
                    continue
                if not chunk:
                    raise ValueError("Sony closed the voice signaling connection.")
                self.ws.receive_data(chunk)
                for event in self.ws.events():
                    if isinstance(event, events.AcceptConnection):
                        send(events.TextMessage(data=json.dumps({
                            "version": version, "method": 1003, "tranId": auth_transaction,
                            "accountId": int(account), "status": "active", "auth": {"accessToken": token},
                        }, separators=(",", ":"))))
                        await writer.drain()
                    elif isinstance(event, events.RejectConnection):
                        raise ValueError(f"Sony rejected voice push (HTTP {event.status_code}).")
                    elif isinstance(event, events.CloseConnection):
                        raise ValueError("Sony closed the voice signaling connection.")
                    elif isinstance(event, events.Ping):
                        send(event.response())
                    elif isinstance(event, events.TextMessage):
                        size += len(event.data)
                        if size > MAX_FRAME:
                            raise ValueError("Sony sent an oversized push frame.")
                        fragments.append(event.data)
                        if event.message_finished:
                            try:
                                frame = json.loads("".join(fragments))
                            except ValueError:
                                frame = None
                            if isinstance(frame, dict):
                                if frame.get("method") == 1003 and str(frame.get("tranId")) == auth_transaction:
                                    code = str(frame.get("returnCode"))
                                    if code != "0":
                                        detail = f" (code {code})" if re.fullmatch(r"-?[0-9]{1,12}", code) else ""
                                        raise ValueError(f"Sony rejected voice push authentication{detail}.")
                                    self.ready.set()
                                elif ":customMessage:" in str(frame.get("dataType")):
                                    if self.frames.full():
                                        self.frames.get_nowait()
                                    self.frames.put_nowait(frame)
                            fragments.clear()
                            size = 0
                await writer.drain()
        finally:
            writer.close()

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
