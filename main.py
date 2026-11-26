"""Decky backend for PlayStation Network social features."""
import asyncio
import base64
import json
import os
import re
import ssl
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

import decky

AUTH = "https://ca.account.sony.com/api/authz/v3/oauth"
MOBILE = "https://m.np.playstation.com/api"
PROFILE = "https://us-prof.np.community.playstation.net/userProfile/v1/users"
USERS = f"{MOBILE}/userProfile/v1/internal/users"
PRESENCES = f"{MOBILE}/userProfile/v2/internal/users/basicPresences"
GROUPS = f"{MOBILE}/gamingLoungeGroups/v1"
PARTIES = f"{MOBILE}/sessionManager/v2"
RTC_BRIDGES = f"{MOBILE}/rtcBridge/v1/bridges"
RTC_HEADERS = {"X-PSN-RTC-TITLE-ID": "METROPOL_AND"}
CLIENT = "09515159-7237-4370-9b40-3806e67c0891"
CLIENT_AUTH = "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
REDIRECT = "com.scee.psxandroid.scecompcall://redirect"
SCOPE = "psn:mobile.v2.core psn:clientapp"
FIELDS = "onlineId,accountId,avatarUrls,personalDetail(@default,profilePictureUrls),primaryOnlineStatus,presences(@default,@titleInfo,platform),trophySummary(level)"
GROUP_FIELDS = "groupName,members,mainThread,existsNewArrival"
PARTY_MEMBER_DATA = "WyIiLCIiLCIxIiwiMCIsIjYuMi4wIiwiMCIsIjAiLCIwIiwiIiwiIl0="
PARTY_BRIDGE_DATA_SLOT = 8


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PsnError(ValueError):
    def __init__(self, status, code=None):
        self.status = status
        detail = f" (PSN code {code})" if code is not None else ""
        super().__init__(f"PlayStation Network returned HTTP {status}{detail}.")


def rtc_media(clock_rate):
    return {"mediaTypes": {
        "application": {"isRequired": True},
        "audio": {"isRequired": True, "opus": [
            {"bitrate": 40, "channels": 1, "codec": "CELT", "ptime": 40, "samplingRates": [clock_rate]},
        ]},
    }}


def bridge_member_peers(members, session, bridge_id):
    identities = {}
    for member in members:
        try:
            fields = json.loads(base64.b64decode(member.get("customData4") or "", validate=True))
            if not isinstance(fields, list) or len(fields) <= PARTY_BRIDGE_DATA_SLOT:
                continue
            bridge, peer = fields[PARTY_BRIDGE_DATA_SLOT].split("\n")
            if bridge != bridge_id:
                continue
            identity = base64.b64decode(member.get("customData3") or "", validate=True).decode().split("\n")
            if len(identity) >= 2 and identity[0] == session and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity[1]):
                identities[identifier(peer)] = identity[1]
        except (ValueError, AttributeError, TypeError):
            continue
    return identities


def tls_context():
    # Decky's bundled Python can point at a certificate directory from its build host.
    for bundle in ("/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem",
                   "/etc/pki/tls/certs/ca-bundle.crt"):
        if Path(bundle).is_file():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


def request(url, method="GET", headers=None, body=None, redirect=False):
    try:
        with build_opener(NoRedirect(), HTTPSHandler(context=tls_context())).open(Request(url, body, headers or {}, method=method), timeout=20) as reply:
            raw = reply.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("PlayStation Network response is too large.")
            return json.loads(raw) if raw else {}
    except HTTPError as error:
        if redirect and error.code in (302, 303):
            return error.headers.get("Location", "")
        code = None
        if url.startswith(PARTIES + "/") and error.code in (400, 409):
            try:
                candidate = json.loads(error.read(8192))["error"]["code"]
                if re.fullmatch(r"[0-9]{1,12}", str(candidate)):
                    code = candidate
            except (ValueError, KeyError, TypeError, OSError):
                pass
        raise PsnError(error.code, code) from None
    except (URLError, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, ssl.SSLCertVerificationError):
            raise ValueError("Could not verify Sony’s TLS certificate. Check the system clock and certificate store.") from None
        if isinstance(reason, TimeoutError):
            raise ValueError("The connection to PlayStation Network timed out.") from None
        raise ValueError("Could not reach PlayStation Network. Check your internet connection and retry.") from None


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise ValueError("Invalid PlayStation identifier.")
    return value


def conversation_identifier(value):
    # Direct-message group/thread IDs use dots and tildes; all are URL-unreserved characters.
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.~-]{1,128}", value) or value in (".", ".."):
        raise ValueError("Invalid PlayStation conversation identifier.")
    return value


def avatar_urls(row):
    personal = row.get("personalDetail") or {}
    candidates = [row.get("profilePicUrl")]
    candidates.extend(item.get("profilePictureUrl") or item.get("url")
                      for item in personal.get("profilePictureUrls") or [] if isinstance(item, dict))
    candidates.append(row.get("avatarUrl"))
    for field in ("avatarUrls", "avatars"):
        candidates.extend(item.get("avatarUrl") or item.get("url")
                          for item in row.get(field) or [] if isinstance(item, dict))

    urls = []
    for url in candidates:
        if not isinstance(url, str):
            continue
        if url.startswith(("http://static-resource.np.community.playstation.net/",
                           "http://psn-rsc.prod.dl.playstation.net/")):
            url = "https://" + url[len("http://"):]
        if url.startswith("https://") and url not in urls:
            urls.append(url)
    return urls


def member_mute(row):
    try:
        fields = json.loads(base64.b64decode(row.get("customData4") or "", validate=True))
        if isinstance(fields, list) and len(fields) > 5 and fields[5] in ("0", "1"):
            return fields[5] == "1"
    except (ValueError, TypeError):
        pass
    return None


def bridge_member_accounts(members, bridge_id):
    accounts = {}
    for member in members:
        try:
            fields = json.loads(base64.b64decode(member.get("customData4") or "", validate=True))
            if not isinstance(fields, list) or len(fields) <= PARTY_BRIDGE_DATA_SLOT:
                continue
            bridge, peer = fields[PARTY_BRIDGE_DATA_SLOT].split("\n")
            if bridge == bridge_id and member.get("accountId"):
                accounts[identifier(peer)] = str(member["accountId"])
        except (ValueError, TypeError, AttributeError):
            continue
    return accounts


def voice_member_data(row):
    fields = json.loads(base64.b64decode(row.get("customData4") or PARTY_MEMBER_DATA, validate=True))
    if not isinstance(fields, list) or len(fields) <= PARTY_BRIDGE_DATA_SLOT:
        raise ValueError("Sony returned an unsupported party member data layout.")
    fields[5] = "0"
    fields[PARTY_BRIDGE_DATA_SLOT] = ""
    return base64.b64encode(json.dumps(fields, separators=(",", ":")).encode()).decode()


def player(row):
    presence = (row.get("presences") or [{}])[0]
    avatars = avatar_urls(row)
    personal = row.get("personalDetail") or {}
    names = (personal.get("firstName"), personal.get("lastName"))
    full_name = " ".join(name.strip() for name in names if isinstance(name, str) and name.strip())
    return {
        "id": str(row["accountId"]),
        "name": row.get("onlineId") or str(row["accountId"]),
        "fullName": full_name or None,
        "avatar": avatars[0] if avatars else None,
        "avatars": avatars,
        "status": row.get("primaryOnlineStatus") or presence.get("onlineStatus"),
        "game": presence.get("titleName") or presence.get("npTitleName"),
        "platform": presence.get("platform"),
        "muted": member_mute(row),
        "level": (row.get("trophySummary") or {}).get("level"),
    }


def message(row):
    detail = row.get("messageDetail") or {}
    body = row.get("body") or detail.get("body")
    sender = row.get("sender") or {}
    return {
        "id": str(row.get("messageUid", "")),
        "text": body if isinstance(body, str) else None,
        "sender": str(sender.get("accountId", "")),
        "name": sender.get("onlineId"),
        "date": row.get("createdTimestamp"),
    }


class Plugin:
    async def _main(self):
        self.path = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "session.json"
        self.device_path = self.path.with_name("device-id")
        self.lock = asyncio.Lock()
        self.voice_lock = asyncio.Lock()
        self.voice = None
        self.bridge_voice = None
        self.voice_push = None
        self.tokens = {}
        try:
            self.tokens = json.loads(self.path.read_text())
        except (OSError, ValueError):
            pass

    def _save(self, tokens):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as file:
            try:
                json.dump(tokens, file)
                file.flush()
                os.replace(file.name, self.path)
            finally:
                Path(file.name).unlink(missing_ok=True)
        self.tokens = tokens

    async def _oauth(self, params):
        correlation_id = str(uuid.uuid4())
        result = await asyncio.to_thread(request, f"{AUTH}/token", "POST", {
            "Authorization": CLIENT_AUTH, "Content-Type": "application/x-www-form-urlencoded",
            "X-Psn-Correlation-Id": correlation_id,
            "User-Agent": "com.sony.snei.np.android.sso.share.oauth.versa.USER_AGENT",
        }, urlencode({**params, "token_format": "jwt", "cid": correlation_id}).encode())
        if not result.get("access_token"):
            raise ValueError("PlayStation sign-in failed.")
        return {
            "access": result["access_token"],
            "refresh": result.get("refresh_token") or params.get("refresh_token"),
            "expires": time.time() + int(result.get("expires_in", 3600)),
        }

    async def sign_in(self, npsso):
        if not isinstance(npsso, str) or not re.fullmatch(r"[A-Za-z0-9_-]{64}", npsso.strip()):
            raise ValueError("Enter a valid Sony NPSSO code.")
        async with self.lock:
            try:
                device_id = self.device_path.read_text().strip()
            except FileNotFoundError:
                device_id = "0000000d00040080" + uuid.uuid4().hex.upper()
                self.device_path.parent.mkdir(parents=True, exist_ok=True)
                self.device_path.write_text(device_id)
            query = urlencode(dict(access_type="offline", client_id=CLIENT, redirect_uri=REDIRECT,
                                   response_type="code", scope=SCOPE, duid=device_id,
                                   device_profile="mobile", service_entity="urn:service-entity:psn"))
            location = await asyncio.to_thread(request, f"{AUTH}/authorize?{query}", "GET",
                                               {"Cookie": f"npsso={npsso.strip()}"}, None, True)
            redirect = urlsplit(location) if isinstance(location, str) else urlsplit("")
            code = parse_qs(redirect.query).get("code", [""])[0]
            if not code or redirect.scheme + "://" + redirect.netloc != REDIRECT:
                raise ValueError("Sony rejected the NPSSO code. Get a fresh code and try again.")
            self._save(await self._oauth(dict(code=code, redirect_uri=REDIRECT, grant_type="authorization_code")))

    async def sign_out(self):
        await self.stop_voice()
        async with self.lock:
            self.path.unlink(missing_ok=True)
            self.tokens = {}

    async def _access(self, rejected=None):
        async with self.lock:
            access = self.tokens.get("access")
            if access and access != rejected and self.tokens.get("expires", 0) > time.time() + 60:
                return access
            refresh = self.tokens.get("refresh")
            if not refresh:
                raise ValueError("Sign in to PlayStation Network first.")
            self._save(await self._oauth(dict(refresh_token=refresh, grant_type="refresh_token", scope=SCOPE)))
            return self.tokens["access"]

    async def _api(self, url, method="GET", payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else None
        access = await self._access()
        extra = dict(headers or {})
        party_request = url.startswith(PARTIES + "/")
        party_session_post = method == "POST" and (
            url == f"{PARTIES}/partySessions" or url.endswith(("/members", "/customMessage", "/bridges"))
        )
        party_session_get = method == "GET" and url.split("?", 1)[0] == f"{PARTIES}/partySessions"
        party_member_patch = method == "PATCH" and url.endswith("/members/me")
        if party_request and not party_session_post and not party_session_get and not party_member_patch:
            extra["X-PSN-SESSION-MANAGER-CPSS-ID"] = "js_DEjjRwWk-4JY_BwF7Fo"
            session = re.search(r"/partySessions/([A-Za-z0-9_-]+)", url)
            if session:
                extra["X-PSN-SESSION-MANAGER-SESSION-IDS"] = session[1]
        def fetch(token):
            return request(url, method, {
                "Authorization": f"Bearer {token}", "Content-Type": "application/json",
                "Accept-Language": "en-US", **extra,
            }, body)
        try:
            try:
                return await asyncio.to_thread(fetch, access)
            except PsnError as error:
                if error.status != 401 or (method != "GET" and not party_request):
                    raise
            return await asyncio.to_thread(fetch, await self._access(rejected=access))
        except PsnError as error:
            if party_request and error.status in (401, 403):
                raise ValueError(
                    f"PlayStation Network rejected PlayDeck’s party access (HTTP {error.status})."
                ) from None
            raise

    async def avatar_image(self, url):
        host = urlsplit(url).hostname
        allowed_hosts = {
            "static-resource.np.community.playstation.net",
            "psn-rsc.prod.dl.playstation.net",
            "image.api.np.km.playstation.net",
            "image.api.playstation.com",
        }
        if not url.startswith("https://") or host not in allowed_hosts:
            return None

        def fetch():
            opener = build_opener(NoRedirect(), HTTPSHandler(context=tls_context()))
            try:
                with opener.open(url, timeout=8) as response:
                    content_type = response.headers.get_content_type()
                    if content_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                        return None
                    limit = 512 * 1024
                    data = response.read(limit + 1)
                    if data and len(data) <= limit:
                        return f"data:{content_type};base64,{base64.b64encode(data).decode('ascii')}"
            except (OSError, ValueError):
                return None
            return None

        return await asyncio.to_thread(fetch)

    async def _update_presences(self, players):
        for offset in range(0, len(players), 50):
            batch = {item["id"]: item for item in players[offset:offset + 50]}
            query = urlencode({
                "type": "primary",
                "accountIds": ",".join(batch),
                "platforms": "PS4,PS5,MOBILE_APP,PSPC",
                "withOwnGameTitleInfo": "true",
            })
            try:
                response = await self._api(f"{PRESENCES}?{query}")
            except PsnError as error:
                if error.status in (401, 403, 404, 429):
                    return
                continue
            except ValueError:
                continue

            for presence in response.get("basicPresences", []):
                item = batch.get(str(presence.get("accountId")))
                primary = presence.get("primaryPlatformInfo") or {}
                status = primary.get("onlineStatus")
                if item is None or not status:
                    continue
                item["status"] = status
                item["platform"] = primary.get("platform")
                titles = presence.get("gameTitleInfoList") or []
                item["game"] = titles[0].get("titleName") if titles and status.lower() != "offline" else None

    async def load(self):
        if not self.tokens:
            return None
        profile = await self._api(f"{PROFILE}/me/profile2?{urlencode(dict(fields=FIELDS, avatarSizes='m,xl', profilePictureSizes='m,xl'))}")
        friends = []
        for offset in range(0, 2000, 100):
            query = urlencode(dict(fields=FIELDS, avatarSizes="m,xl", profilePictureSizes="m,xl", offset=offset, limit=100))
            page = await self._api(f"{PROFILE}/me/friends/profiles2?{query}")
            items = page["profiles"]
            friends.extend(map(player, items))
            if not items or len(friends) >= int(page.get("totalResults", len(friends))):
                break
        me = player(profile["profile"])
        friends = list({item["id"]: item for item in friends}.values())
        await self._update_presences([me, *friends])
        return {"me": me, "friends": friends}

    async def search(self, query):
        query = query.strip()
        if not query or len(query) > 100:
            raise ValueError("Enter a PlayStation Online ID.")
        result = await self._api(f"{MOBILE}/search/v1/universalSearch", "POST", {
            "searchTerm": query, "domainRequests": [{"domain": "SocialAllAccounts"}],
        })
        domains = result.get("domainResponses") or [{}]
        return [player(row["socialMetadata"]) for row in domains[0].get("results", []) if row.get("socialMetadata", {}).get("accountId")]

    async def relationships(self, blocked):
        path, key = ("blocks", "blockList") if blocked else ("friends/receivedRequests", "receivedRequests")
        accounts = []
        for offset in range(0, 2000, 100):
            query = urlencode(dict(limit=100, offset=offset))
            result = await self._api(f"{USERS}/me/{path}?{query}")
            page = result.get(key, [])
            accounts.extend(str(account) for account in page)
            if not page or len(accounts) >= result.get("totalItemCount", len(accounts)):
                break
        profiles = {}
        for offset in range(0, len(accounts), 100):
            query = urlencode(dict(accountIds=",".join(accounts[offset:offset + 100])))
            result = await self._api(f"{USERS}/profiles?{query}")
            profiles.update({str(row["accountId"]): player(row) for row in result.get("profiles", [])})
        return [profiles.get(account) or {"id": account, "name": account} for account in dict.fromkeys(accounts)]

    async def _update_profiles(self, players):
        participants = {person["id"]: person for person in players}
        missing = [account for account, member in participants.items() if not member.get("avatar")]
        for offset in range(0, len(missing), 100):
            batch = missing[offset:offset + 100]
            query = urlencode({"accountIds": ",".join(batch)})
            try:
                response = await self._api(f"{USERS}/profiles?{query}")
            except (ValueError, OSError):
                continue
            profiles = response.get("profiles", [])
            names = {participants[account]["name"].casefold(): account for account in batch}
            for index, row in enumerate(profiles):
                if not isinstance(row, dict) or not row.get("onlineId"):
                    continue
                # This endpoint omits accountId; match Online IDs first, then its ordered response.
                account = str(row.get("accountId") or names.get(row["onlineId"].casefold()) or
                              (batch[index] if len(profiles) == len(batch) else ""))
                if account in participants:
                    profile = player({**row, "accountId": account})
                    participants[account].update({key: value for key, value in profile.items()
                                                   if value is not None and value != []})

    async def inbox(self):
        async def groups(favorite):
            query = urlencode(dict(favoriteFilter=favorite, includeFields=GROUP_FIELDS, limit=200))
            return (await self._api(f"{GROUPS}/members/me/groups?{query}"))["groups"]
        pages = await asyncio.gather(groups("notFavorite"), groups("favorite"))
        threads = {}
        for group in pages[0] + pages[1]:
            thread = group.get("mainThread") or {}
            threads[group["groupId"]] = {
                "id": group["groupId"], "thread": thread.get("threadId") or group["groupId"],
                "name": (group.get("groupName") or {}).get("value"),
                "members": [player(row) for row in group.get("members", []) if row.get("accountId")],
                "unread": bool(thread.get("existsUnreadMessage")),
                "latest": message(thread["latestMessage"]) if thread.get("latestMessage") else None,
            }
        participants = {}
        for chat in threads.values():
            for member in chat["members"]:
                existing = participants.get(member["id"])
                if existing is None or (not existing.get("avatar") and member.get("avatar")):
                    participants[member["id"]] = member
        await self._update_profiles(list(participants.values()))
        await self._update_presences(list(participants.values()))
        for chat in threads.values():
            chat["members"] = [participants[member["id"]] for member in chat["members"]]
        return sorted(threads.values(), key=lambda item: (item["latest"] or {}).get("date") or "", reverse=True)

    async def create_chat(self, account):
        result = await self._api(f"{GROUPS}/groups", "POST", {"invitees": [{"accountId": identifier(account)}]})
        return {"id": result["groupId"], "thread": (result.get("mainThread") or {}).get("threadId") or result["groupId"]}

    async def messages(self, group, thread):
        path = f"{GROUPS}/members/me/groups/{conversation_identifier(group)}/threads/{conversation_identifier(thread)}/messages"
        result = await self._api(path)
        people = {}
        for row in result["messages"]:
            sender = row.get("sender") or {}
            if sender.get("accountId"):
                people[str(sender["accountId"])] = player(sender)
        await self._update_profiles(list(people.values()))
        messages = []
        for row in result["messages"]:
            item = message(row)
            profile = people.get(item["sender"], {})
            item.update({"avatar": profile.get("avatar"), "avatars": profile.get("avatars", []),
                         "name": profile.get("name") or item["name"]})
            messages.append(item)
        return sorted(messages, key=lambda row: row["date"] or "")

    async def send_message(self, group, thread, text):
        if not isinstance(text, str) or not text.strip() or len(text) > 256:
            raise ValueError("Enter a message of up to 256 characters.")
        await self._api(f"{GROUPS}/groups/{conversation_identifier(group)}/threads/{conversation_identifier(thread)}/messages",
                        "POST", {"messageType": 1, "body": text.strip()})

    async def parties(self):
        response = await self._api(f"{PARTIES}/users/me/partySessionsInvitations")
        keys = ("invitations", "partySessionsInvitations", "invitedPartySessions")
        invites = response if isinstance(response, list) else next((response[key] for key in keys if response.get(key)), [])
        ids = []
        for invite in invites:
            session = invite.get("party") or invite.get("session") or invite.get("v2PartySession") or {}
            session_id = invite.get("partySessionId") or invite.get("sessionId") or session.get("sessionId")
            if session_id:
                ids.append(identifier(session_id))
        result = await self._api(f"{PARTIES}/sys/gameBase/parties/bulkGet?limit=11", "POST",
                                 {"groupInvitedPartySessions": list(dict.fromkeys(ids))[:11]})
        parties = {row["sessionId"]: {
            "id": row["sessionId"], "name": row.get("sessionName"),
            "members": [player(member) for member in row.get("members", []) if member.get("accountId")],
            "invited": row["sessionId"] in ids,
        } for row in result.get("parties", []) if row.get("sessionId")}
        for session_id in ids:
            parties.setdefault(session_id, {"id": session_id, "name": None, "members": [], "invited": True})
        if parties:
            try:
                details = await self._api(f"{PARTIES}/partySessions?view=v3", headers={
                    "X-PSN-SESSION-MANAGER-SESSION-IDS": ",".join(parties)})
                for room in details.get("v2PartySessions", []):
                    party = parties.get(room.get("sessionId"))
                    if party:
                        known = {member["id"]: member for member in party["members"]}
                        members = []
                        for row in room.get("members", []):
                            if row.get("accountId"):
                                member = known.get(str(row["accountId"])) or player(row)
                                member["muted"] = member_mute(row)
                                members.append(member)
                        party["members"] = members
            except (ValueError, OSError):
                # Browsing parties remains available if full member data is restricted.
                pass
        await self._update_presences([member for party in parties.values() for member in party["members"]])
        return list(parties.values())

    def _party_member(self):
        voice_ready = self.voice_push is not None and not self.voice_push[0].task.done()
        return {"accountId": "me", "platform": "me", "voiceChatActivated": voice_ready,
                "pushContexts": [{"contextId": str(uuid.uuid4())}], "customData4": PARTY_MEMBER_DATA}

    async def create_party(self, friends_only):
        await self.prepare_voice()
        visibility = "FRIENDS_ONLY" if friends_only else "INVITE_ONLY"
        response = await self._api(f"{PARTIES}/partySessions", "POST", {"v2PartySessions": [{
            "sessionType": "ROOM", "sessionName": "", "maxMembers": 16,
            "visibilityType": visibility, "joinableUserType": "FRIENDS" if friends_only else "INVITE_ONLY",
            "members": [self._party_member()],
        }]}, {
            "Content-Type": "application/json; charset=utf-8",
            "X-PSN-SESSION-MANAGER-SET-PROFANITY-FILTER-LANGUAGE-CODE": "en-US",
        })
        return response["v2PartySessions"][0]["sessionId"]

    async def join_party(self, session):
        session = identifier(session)
        await self.prepare_voice()
        await self._api(f"{PARTIES}/partySessions/{session}/members",
                        "POST", {"members": [self._party_member()]},
                        {"Content-Type": "application/json; charset=utf-8"})

    async def leave_party(self, session):
        await self.stop_voice(session)
        try:
            await self._api(f"{PARTIES}/partySessions/{identifier(session)}/members/me", "DELETE")
        except PsnError as error:
            if error.status != 404:
                raise

    async def prepare_voice(self):
        async with self.voice_lock:
            if self.voice or self.bridge_voice:
                raise ValueError("Disconnect the current party voice session first.")
            # Decky loads main.py directly. Resolve the packaged transport beside it.
            plugin_dir = str(Path(__file__).resolve().parent)
            if plugin_dir not in sys.path:
                sys.path.insert(0, plugin_dir)
            from voice_push import PUSH_DISCOVERY, VoicePush

            if self.voice_push and not self.voice_push[0].task.done():
                return
            if self.voice_push:
                await self.voice_push[0].close()
                self.voice_push = None
            token = await self._access()
            claims = token.split(".")[1]
            account = str(json.loads(base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4)))["account_id"])
            push = VoicePush()
            push_headers = {"User-Agent": "Dalvik/2.1.0 (Linux; U; Android 16)"}
            discovery = None
            for version, keepalive in (("3.0", "6"), ("2.1", "3")):
                query = urlencode({"keepAliveStatusType": keepalive, "fields": "keepAliveStatus",
                                   "version": version})
                for headers in ({**push_headers, "Authorization": f"Bearer {token}"}, push_headers):
                    try:
                        discovery = await asyncio.to_thread(request, f"{PUSH_DISCOVERY}?{query}", "GET", headers)
                    except PsnError as error:
                        if error.status not in (400, 401, 403, 404):
                            raise
                    else:
                        if isinstance(discovery, dict) and isinstance(discovery.get("fqdn"), str):
                            break
                        discovery = None
                if discovery:
                    break
            if discovery is None:
                raise ValueError("Sony did not provide a party voice push server.")
            settings = discovery.get("keepAliveStatus") or {}
            interval = settings.get("clientKeepAliveInterval", 60000)
            interval = max(5, min(60, interval / 1000)) if isinstance(interval, (int, float)) else 60
            push_tls = tls_context()
            # The push server omits its intermediate. Require a chain to a system root.
            push_tls.load_verify_locations(cafile=Path(__file__).with_name("psn-push-intermediate.pem"))
            push_tls.verify_flags &= ~getattr(ssl, "VERIFY_X509_PARTIAL_CHAIN", 0)
            await push.connect(discovery["fqdn"], token, account, push_tls, version, keepalive, interval)
            self.voice_push = (push, account)
            decky.logger.info("Sony acknowledged voice push authentication before joining a party.")

    async def start_voice(self, session):
        session = identifier(session)
        async with self.voice_lock:
            if self.voice or self.bridge_voice:
                raise ValueError("Disconnect the current party voice session first.")
            if not self.voice_push or self.voice_push[0].task.done():
                raise ValueError("Prepare voice before creating or joining the party.")
            push, account = self.voice_push
            voice = {"session": session, "account": account, "push": push, "sequence": 0, "members": {}}
            await self._refresh_voice_members(voice)
            identity = base64.b64encode(f"{session}\n{account.zfill(21)}\n".encode()).decode()
            await self._api(f"{PARTIES}/partySessions/{session}/members/me", "PATCH",
                            {"customData3": identity}, {"Content-Type": "application/json; charset=utf-8"})
            decky.logger.info("PSN accepted the party voice member identity.")
            self.voice = voice
            decky.logger.info("Started party voice using the prepared PSN push connection.")

    async def start_bridge_voice(self, session):
        session = identifier(session)
        await self.prepare_voice()
        async with self.voice_lock:
            if self.voice or self.bridge_voice:
                raise ValueError("Disconnect the current party voice session first.")
            if not self.voice_push or self.voice_push[0].task.done():
                raise ValueError("Prepare voice before creating or joining the party.")
            account = self.voice_push[1]
            party = await self._refresh_voice_members({"session": session, "account": account})
            member = next(row for row in party["members"] if str(row.get("accountId")) == account)
            signaling_id = identifier(member.get("deviceUniqueId"))
            party_bridges = f"{PARTIES}/partySessions/{session}/bridges"
            response = await self._api(f"{PARTIES}/partySessions?view=v2",
                                       headers={"X-PSN-SESSION-MANAGER-SESSION-IDS": session})
            bridge_party = next((row for row in response.get("v2PartySessions", [])
                                 if row.get("sessionId") == session), None)
            if bridge_party is None:
                raise ValueError("Sony did not return bridge information for the active party.")
            bridges = bridge_party.get("bridges") or []
            if bridges:
                bridge = bridges[0]
                if not bridge.get("bridgeToken"):
                    raise ValueError("Sony did not return access to the party’s existing voice bridge.")
                decky.logger.info("Reusing the PlayStation party’s existing Sony voice bridge.")
            else:
                try:
                    bridge = (await self._api(RTC_BRIDGES, "POST", {}, RTC_HEADERS))["bridge"]
                except PsnError as error:
                    raise ValueError(f"Could not create a Sony voice bridge. {error}") from None
            voice = {"session": session, "id": identifier(bridge["bridgeId"]),
                     "headers": {**RTC_HEADERS, "X-PSN-BRIDGE-TOKEN": bridge["bridgeToken"]},
                     "peer": None, "clock_rate": 16000, "unlinked": not bridges, "published": False,
                     "identity": base64.b64encode(f"{session}\n{signaling_id}\n".encode()).decode(),
                     "account": account,
                     "member_data": voice_member_data(member)}
            self.bridge_voice = voice
            stage = "link the voice bridge to the party"
            try:
                if voice["unlinked"]:
                    await self._api(party_bridges, "POST", {
                        "bridges": [{"bridgeId": voice["id"], "bridgeToken": bridge["bridgeToken"]}],
                    }, {
                        "Content-Type": "application/json; charset=utf-8",
                        "X-PSN-SESSION-MANAGER-IGNORE-CONFLICT": "true",
                    })
                    voice["unlinked"] = False
                stage = "open a peer on the voice bridge"
                peers_url = f'{RTC_BRIDGES}/{voice["id"]}/peers?allow_duid_duplication=false&g=2'
                try:
                    result = await self._api(peers_url, "POST", rtc_media(voice["clock_rate"]), voice["headers"])
                except PsnError as error:
                    if error.status not in (400, 406, 422):
                        raise
                    decky.logger.info("Sony rejected the 16 kHz voice profile. Trying 48 kHz.")
                    voice["clock_rate"] = 48000
                    result = await self._api(peers_url, "POST", rtc_media(voice["clock_rate"]), voice["headers"])
                peer = result["peer"]
                voice["peer"] = identifier(peer["peerId"])
                offer = peer["offer"]["sdp"]
                clock = re.search(r"^a=rtpmap:\d+ opus/(\d+)/", offer, re.IGNORECASE | re.MULTILINE)
                decky.logger.info("Sony returned a party bridge offer with Opus clock %s Hz.",
                                  clock.group(1) if clock else "unknown")
                return {"offer": offer, "account": account, "peer": voice["peer"], "signalingId": signaling_id}
            except PsnError as error:
                await self._close_bridge_voice()
                raise ValueError(f"Could not {stage}. {error}") from None
            except BaseException:
                await self._close_bridge_voice()
                raise

    def _bridge_peer(self, session):
        voice = self.bridge_voice
        if not voice or voice["session"] != session or not voice["peer"]:
            raise ValueError("The party voice bridge session ended.")
        return f'{RTC_BRIDGES}/{voice["id"]}/peers/{voice["peer"]}', voice["headers"]

    async def answer_bridge_voice(self, session, sdp):
        if not isinstance(sdp, str) or not sdp.startswith("v=0") or len(sdp) > 65536:
            raise ValueError("Invalid voice bridge answer.")
        async with self.voice_lock:
            peer, headers = self._bridge_peer(session)
            layout = []
            for line in sdp.splitlines():
                if line.startswith("m="):
                    fields = line[2:].split()
                    if len(fields) >= 3:
                        layout.append(f"m={fields[0]}:{fields[1]}:{fields[2]}")
                elif line.startswith("a="):
                    key, _, value = line[2:].partition(":")
                    if key == "candidate":
                        fields = value.split()
                        if len(fields) >= 8:
                            layout.append(f"candidate:{fields[1]}:{fields[2]}:{fields[7]}")
                    elif key in {"ice-ufrag", "ice-pwd"}:
                        layout.append(f"{key}[{len(value)}]")
                    elif key in {"group", "setup", "mid", "ice-options"}:
                        layout.append(f"{key}:{value}")
                    else:
                        layout.append(key)
            decky.logger.info("Sony bridge answer layout (%s): %s",
                              "native" if self.bridge_voice.get("native") else "Steam", " ".join(layout))
            await self._api(f"{peer}/answer", "POST", {"answer": {"sdp": sdp}}, headers)
            decky.logger.info("Sony accepted the party bridge answer.")
            voice = self.bridge_voice
            if not voice["published"]:
                fields = json.loads(base64.b64decode(voice["member_data"], validate=True))
                if not isinstance(fields, list) or len(fields) <= PARTY_BRIDGE_DATA_SLOT:
                    raise ValueError("Sony returned an unsupported party member data layout.")
                fields[PARTY_BRIDGE_DATA_SLOT] = f'{voice["id"]}\n{voice["peer"]}'
                data = base64.b64encode(json.dumps(fields, separators=(",", ":")).encode()).decode()
                # Session Manager handles the signaling identity and bridge mapping as separate updates.
                try:
                    await self._api(f"{PARTIES}/partySessions/{session}/members/me", "PATCH",
                                    {"customData3": voice["identity"]},
                                    {"Content-Type": "application/json; charset=utf-8"})
                    decky.logger.info("Sony accepted the separate party voice identity update.")
                except PsnError as error:
                    decky.logger.warning("Sony rejected the separate party voice identity update: %s", error)
                await self._set_bridge_member_data(session, data)
                voice["published"] = True
                decky.logger.info("Sony accepted the Deck’s party bridge peer mapping.")

    async def set_voice_mute(self, session, muted):
        session = identifier(session)
        if not isinstance(muted, bool):
            raise ValueError("Microphone mute must be a boolean.")
        async with self.voice_lock:
            voice = self.bridge_voice or self.voice
            if not voice or voice["session"] != session:
                raise ValueError("The party voice session is no longer active.")
            fields = json.loads(base64.b64decode(voice.get("member_data") or PARTY_MEMBER_DATA, validate=True))
            if not isinstance(fields, list) or len(fields) <= PARTY_BRIDGE_DATA_SLOT:
                raise ValueError("Sony returned an unsupported party member data layout.")
            # PS App's microphone mute property is customData4 slot 5.
            fields[5] = "1" if muted else "0"
            member_data = base64.b64encode(json.dumps(fields, separators=(",", ":")).encode()).decode()
            if voice.get("published"):
                fields[PARTY_BRIDGE_DATA_SLOT] = f'{voice["id"]}\n{voice["peer"]}'
            data = base64.b64encode(json.dumps(fields, separators=(",", ":")).encode()).decode()
            await self._set_bridge_member_data(session, data)
            voice["member_data"] = member_data

    async def _set_bridge_member_data(self, session, data):
        await self._api(f"{PARTIES}/partySessions/{session}/members/me", "PATCH",
                        {"customData4": data}, {"Content-Type": "application/json; charset=utf-8"})

    async def refresh_bridge_offer(self, session):
        async with self.voice_lock:
            peer, headers = self._bridge_peer(session)
            result = await self._api(f"{peer}/offer", "POST", rtc_media(self.bridge_voice["clock_rate"]), headers)
            return result["offer"]["sdp"]

    async def _native_voice_command(self, voice, command):
        process = voice["native"]
        process.stdin.write(json.dumps(command, separators=(",", ":")).encode() + b"\n")
        await process.stdin.drain()
        reply = await asyncio.wait_for(process.stdout.readline(), 20)
        if not reply:
            raise ValueError("The native party voice helper stopped.")
        result = json.loads(reply)
        if result.get("error"):
            raise ValueError(result["error"])
        return result

    async def start_native_bridge(self, session, offer, local_offer):
        async with self.voice_lock:
            self._bridge_peer(session)
            voice = self.bridge_voice
            if voice.get("native"):
                raise ValueError("Native party voice is already running.")
            executable = Path(__file__).resolve().parent / "dist" / "party-voice-native"
            if not executable.is_file():
                return None
            if any(not isinstance(sdp, str) or not sdp.startswith("v=0") or len(sdp) > 65536
                   for sdp in (offer, local_offer)):
                raise ValueError("Invalid native voice offer.")
            try:
                voice["native"] = await asyncio.create_subprocess_exec(
                    str(executable), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    limit=1024 * 1024,
                )
                result = await self._native_voice_command(
                    voice, {"type": "start", "offer": offer, "localOffer": local_offer})
                decky.logger.info("Native party voice prepared the Sony and Steam answers.")
                return result
            except (ValueError, TimeoutError, OSError) as error:
                detail = str(error).partition("\n")[0][:240] or type(error).__name__
                if re.search(r"ice-pwd|ice-ufrag|a=candidate|a=fingerprint", detail, re.IGNORECASE):
                    detail = "invalid SDP"
                decky.logger.warning("Native party voice could not start (%s). Using Steam WebRTC.", detail)
                await self._stop_native_bridge(voice)
                return None

    async def answer_native_bridge(self, session, offer):
        async with self.voice_lock:
            self._bridge_peer(session)
            if not isinstance(offer, str) or not offer.startswith("v=0") or len(offer) > 65536:
                raise ValueError("Invalid native voice offer.")
            result = await self._native_voice_command(self.bridge_voice, {"type": "answer", "offer": offer})
            return result["answer"]

    async def exchange_native_bridge(self, session, commands):
        async with self.voice_lock:
            self._bridge_peer(session)
            if not isinstance(commands, list) or len(json.dumps(commands)) > 262144:
                raise ValueError("Invalid native voice commands.")
            voice = self.bridge_voice
            snapshot = await self._native_voice_command(voice, {"type": "exchange", "commands": commands})
            if snapshot.get("state") != voice.get("native_state"):
                voice["native_state"] = snapshot.get("state")
                decky.logger.info("Native party voice Sony connection state: %s", voice["native_state"])
            if snapshot.get("iceState") != voice.get("native_ice_state"):
                voice["native_ice_state"] = snapshot.get("iceState")
                decky.logger.info("Native party voice Sony ICE state: %s", voice["native_ice_state"])
            for key, description in (("sent", "sent microphone"), ("received", "received party")):
                milestone = f"native_{key}"
                if snapshot.get(key) and not voice.get(milestone):
                    voice[milestone] = True
                    decky.logger.info("Native party voice %s audio packets.", description)
            return snapshot

    async def bridge_voice_peers(self, session):
        async with self.voice_lock:
            _, headers = self._bridge_peer(session)
            voice = self.bridge_voice
            result = await self._api(f'{RTC_BRIDGES}/{voice["id"]}?fields=peer.peerId', headers=headers)
            peers = (result.get("bridge") or {}).get("peers") or []
            ids = sorted({identifier(peer["peerId"]) for peer in peers
                          if peer.get("peerId") and peer["peerId"] != voice["peer"]})
            identities = {}
            accounts = {}
            muted = {}
            if ids:
                try:
                    party = await self._refresh_voice_members(voice)
                    members = party.get("members", [])
                    identities = bridge_member_peers(members, session, voice["id"])
                    muted = {str(member.get("accountId")): member_mute(member) for member in members}
                    accounts = bridge_member_accounts(members, voice["id"])
                except (ValueError, OSError):
                    # Bridge media remains usable while the party member view is unavailable.
                    pass
            return [{"id": peer, "identity": identities.get(peer),
                     "account": accounts.get(peer),
                     "muted": muted.get(accounts.get(peer))} for peer in ids]

    async def _stop_native_bridge(self, voice):
        process = voice.pop("native", None)
        if process is not None:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 2)
            except TimeoutError:
                if process.returncode is None:
                    process.kill()
                await process.wait()

    async def _close_bridge_voice(self):
        voice, self.bridge_voice = self.bridge_voice, None
        await self._stop_native_bridge(voice)
        if voice["published"]:
            try:
                await self._set_bridge_member_data(voice["session"], voice["member_data"])
            except ValueError:
                decky.logger.warning("Could not clear the Deck’s PSN voice bridge peer mapping.")
        bridge = f'{RTC_BRIDGES}/{voice["id"]}'
        target = f'{bridge}/peers/{voice["peer"]}' if voice["peer"] else bridge if voice["unlinked"] else None
        if target:
            try:
                await self._api(target, "DELETE", headers=voice["headers"])
            except ValueError:
                decky.logger.warning("Could not release a PSN voice bridge resource.")

    async def _refresh_voice_members(self, voice):
        from voice_push import PLATFORMS

        session = voice["session"]
        unavailable = "This party is no longer available. Refresh Parties and join a current party."
        try:
            response = await self._api(f"{PARTIES}/partySessions?view=v3",
                                       headers={"X-PSN-SESSION-MANAGER-SESSION-IDS": session})
        except PsnError as error:
            if error.status == 404:
                raise ValueError(unavailable) from None
            raise
        party = next((row for row in response.get("v2PartySessions", []) if row.get("sessionId") == session), None)
        if party is None:
            raise ValueError(unavailable)
        if not any(str(member.get("accountId")) == voice["account"] for member in party.get("members", [])):
            raise ValueError("You are no longer a member of this party. Refresh Parties and join again.")
        voice["members"] = {str(member["accountId"]): member["platform"] for member in party.get("members", [])
                            if member.get("accountId") and str(member["accountId"]) != voice["account"]
                            and member.get("platform") in PLATFORMS}
        voice["member_mutes"] = {str(member.get("accountId")): member_mute(member) for member in party.get("members", [])}
        voice["members_checked"] = time.monotonic()
        return party

    async def voice_events(self, session):
        from voice_push import VoiceMessageError, voice_description

        async with self.voice_lock:
            voice = self.voice
            if not voice or voice["session"] != session:
                raise ValueError("The party voice session ended.")
            push = voice["push"]
            if push.task.done():
                try:
                    await push.task
                except Exception as error:
                    raise ValueError("Sony's party voice signaling connection closed.") from error
                raise ValueError("Sony's party voice signaling connection closed.")
            if time.monotonic() - voice["members_checked"] >= 2:
                await self._refresh_voice_members(voice)
            descriptions = []
            while not push.frames.empty():
                frame = push.frames.get_nowait()
                try:
                    description = voice_description(frame, session, voice["account"])
                except VoiceMessageError as error:
                    decky.logger.info("Ignored PSN custom message: %s.", error)
                    continue
                if description["account"] not in voice["members"]:
                    await self._refresh_voice_members(voice)
                if description["account"] in voice["members"]:
                    descriptions.append(description)
                    if description["type"] == "error":
                        decky.logger.info("Received PSN party voice error code %s.", description["code"])
                    else:
                        decky.logger.info("Received PSN party voice %s from a party member.", description["type"])
                else:
                    decky.logger.info("Ignored PSN custom message: sender is not in the active party.")
            return {"members": list(voice["members"]), "descriptions": descriptions, "muted": voice.get("member_mutes", {})}

    async def send_voice_description(self, session, member, description):
        from voice_push import MAX_SDP, voice_payload

        if not isinstance(description, dict):
            raise ValueError("Invalid party voice description.")
        sdp = description.get("sdp")
        if (description.get("type") not in {"offer", "answer"} or not isinstance(sdp, str)
                or not sdp.startswith("v=0") or len(sdp) > MAX_SDP
                or not re.fullmatch(r"[0-9]{1,10}", str(description.get("sequence")))):
            raise ValueError("Invalid party voice description.")
        async with self.voice_lock:
            voice = self.voice
            if not voice or voice["session"] != session or member not in voice["members"]:
                raise ValueError("The recipient is no longer in the party voice session.")
            sequence = voice["sequence"]
            voice["sequence"] += 1
            payload = voice_payload(voice["account"], member, voice["members"][member], description, sequence)
            await self._api(f"{PARTIES}/partySessions/{session}/customMessage", "POST", payload)
            candidate_types = sorted(set(re.findall(r"^a=candidate:[^\r\n]*\btyp (host|srflx|prflx|relay)\b", sdp, re.M)))
            decky.logger.info("PSN accepted the party voice %s (ICE candidate types: %s).",
                              description["type"], ", ".join(candidate_types) or "none")

    async def stop_voice(self, session=None):
        async with self.voice_lock:
            if self.voice and (session is None or self.voice["session"] == session):
                self.voice = None
            if self.bridge_voice and (session is None or self.bridge_voice["session"] == session):
                await self._close_bridge_voice()
            if session is None and self.voice_push:
                push, _ = self.voice_push
                self.voice_push = None
                await push.close()

    async def _unload(self):
        await self.stop_voice()

    async def invite(self, session, account):
        await self._api(f"{PARTIES}/partySessions/{identifier(session)}/invitations", "POST", {
            "invitationType": "NORMAL", "invitations": [{"to": {"accountId": identifier(account)}}],
            "invitationsToGroups": [],
        })
