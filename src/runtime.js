import { installPartyBadge } from "./party-badge.js";
import { installSteamMainMenuEntry } from "./steam-main-menu.js";
import { partyMemberPresentation, bridgePeerState, readVoiceConnectionMode } from "./party-presentation.js";
const manifest = {"name":"PlayDeck"};
const API_VERSION = 2;
const internalAPIConnection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!internalAPIConnection) {
    throw new Error('[@decky/api]: Failed to connect to the loader as as the loader API was not initialized. This is likely a bug in Decky Loader.');
}
let api$1;
try {
    api$1 = internalAPIConnection.connect(API_VERSION, manifest.name);
}
catch {
    api$1 = internalAPIConnection.connect(1, manifest.name);
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version 1. Some features may not work.`);
}
if (api$1._version != API_VERSION) {
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version ${api$1._version}. Some features may not work.`);
}
const callable = api$1.callable;
const definePlugin = (fn) => {
    return (...args) => {
        return fn(...args);
    };
};

function WideModal({ children, ...props }) {
    return SP_REACT.createElement(DFL.ModalRoot, { ...props, bAllowFullSize: true, modalClassName: "nexus-wide-modal" },
        SP_REACT.createElement("style", null, `
      .nexus-wide-modal {
        width: calc(100vw - 32px) !important;
        max-width: none !important;
        box-sizing: border-box;
      }
    `),
        children);
}

function correctMicrophoneClock({ readable, writable }, isNarrowband, report) {
    let original;
    let corrected = 0;
    let remainder = 0;
    let supported = true;
    let reported = false;
    return readable.pipeThrough(new TransformStream({
        transform(frame, controller) {
            if (!isNarrowband())
                original = undefined;
            else if (supported) {
                const metadata = frame.getMetadata();
                const timestamp = metadata.rtpTimestamp ?? frame.timestamp;
                if (original === undefined) {
                    original = corrected = timestamp;
                    remainder = 0;
                }
                else {
                    const ticks = ((timestamp - original) >>> 0) + remainder;
                    const steps = Math.floor(ticks / 3);
                    const next = (corrected + steps) >>> 0;
                    try {
                        const updated = { ...metadata, rtpTimestamp: next };
                        let updatedFrame = frame;
                        if (frame.setMetadata)
                            frame.setMetadata(updated);
                        else {
                            const { RTCEncodedAudioFrame } = globalThis;
                            updatedFrame = new RTCEncodedAudioFrame(frame, { metadata: updated });
                        }
                        if ((updatedFrame.getMetadata().rtpTimestamp ?? updatedFrame.timestamp) !== next) {
                            throw new Error("Steam ignored the microphone timestamp update.");
                        }
                        frame = updatedFrame;
                        original = timestamp;
                        corrected = next;
                        remainder = ticks % 3;
                        if (!reported) {
                            reported = true;
                            report("correcting");
                        }
                    }
                    catch {
                        supported = false;
                        report("unsupported");
                    }
                }
            }
            controller.enqueue(frame);
        },
    })).pipeTo(writable);
}
// This function is also serialized into the modern WebRTC transform worker.
function correctPartyAudioClock({ readable, writable }, report, playPacket) {
    const clocks = new Map();
    let writableTimestamps = true;
    const transform = new TransformStream({
        transform(frame, controller) {
            playPacket?.(frame);
            const metadata = frame.getMetadata();
            const { synchronizationSource, sequenceNumber } = metadata;
            const timestamp = metadata.rtpTimestamp ?? frame.timestamp;
            if (writableTimestamps && synchronizationSource !== undefined && Number.isFinite(timestamp)) {
                let clock = clocks.get(synchronizationSource);
                if (!clock) {
                    clock = { sequence: sequenceNumber, timestamp, matches: 0 };
                    clocks.set(synchronizationSource, clock);
                }
                else if (clock.anchor === undefined) {
                    const consecutive = sequenceNumber === undefined || clock.sequence === undefined ||
                        ((sequenceNumber - clock.sequence) & 0xffff) === 1;
                    const ticks = (timestamp - clock.timestamp) >>> 0;
                    // Sony's 40 ms packets advance by 640 ticks on a 16 kHz stream.
                    clock.matches = consecutive && ticks === 640 ? clock.matches + 1 : 0;
                    if (clock.matches === 2)
                        clock.anchor = clock.timestamp;
                    clock.sequence = sequenceNumber;
                    clock.timestamp = timestamp;
                }
                if (clock.anchor !== undefined) {
                    const corrected = (clock.anchor + 3 * (timestamp - clock.anchor)) >>> 0;
                    try {
                        const updated = { ...metadata, rtpTimestamp: corrected };
                        let correctedFrame = frame;
                        if (frame.setMetadata) {
                            frame.setMetadata(updated);
                        }
                        else {
                            const { RTCEncodedAudioFrame } = globalThis;
                            correctedFrame = new RTCEncodedAudioFrame(frame, { metadata: updated });
                        }
                        if ((correctedFrame.getMetadata().rtpTimestamp ?? correctedFrame.timestamp) !== corrected) {
                            throw new Error("Steam ignored the RTP timestamp update.");
                        }
                        frame = correctedFrame;
                        if (clock.matches === 2) {
                            report("correcting");
                            clock.matches = 0;
                        }
                    }
                    catch {
                        writableTimestamps = false;
                        report("unsupported");
                    }
                }
            }
            controller.enqueue(frame);
        },
    });
    return readable.pipeThrough(transform).pipeTo(writable);
}
function createOpusPlayback(context, audio, active) {
    const sources = new Map();
    const scheduled = new Set();
    let enabled = true;
    let playing = false;
    function close() {
        enabled = false;
        for (const { decoder } of sources.values()) {
            if (decoder.state !== "closed")
                decoder.close();
        }
        sources.clear();
        for (const source of scheduled)
            source.stop();
        scheduled.clear();
        audio.muted = false;
    }
    function playPacket(frame) {
        if (!enabled || context.state !== "running" || !frame.data.byteLength)
            return;
        const { synchronizationSource = 0, sequenceNumber, mimeType } = frame.getMetadata();
        if (mimeType && mimeType.toLowerCase() !== "audio/opus")
            return;
        try {
            let source = sources.get(synchronizationSource);
            if (!source) {
                let nextPlay = 0;
                let lastTimestamp;
                let lastDuration = 0;
                const decoder = new AudioDecoder({
                    error: close,
                    output(data) {
                        try {
                            if (!enabled)
                                return;
                            const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
                            for (let channel = 0; channel < data.numberOfChannels; channel++) {
                                data.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: "f32-planar" });
                            }
                            const now = context.currentTime;
                            if (lastTimestamp !== undefined) {
                                const missed = Math.max(0, (data.timestamp - lastTimestamp) / 40000 - 1);
                                nextPlay += Math.min(missed * lastDuration, 0.12);
                            }
                            lastTimestamp = data.timestamp;
                            lastDuration = buffer.duration;
                            if (nextPlay > now + 0.4)
                                return;
                            if (nextPlay < now)
                                nextPlay = now + 0.1;
                            const node = context.createBufferSource();
                            node.buffer = buffer;
                            node.connect(context.destination);
                            node.onended = () => scheduled.delete(node);
                            node.start(nextPlay);
                            scheduled.add(node);
                            nextPlay += buffer.duration;
                            if (!playing) {
                                playing = true;
                                audio.muted = true;
                                active();
                            }
                        }
                        catch {
                            close();
                        }
                        finally {
                            data.close();
                        }
                    },
                });
                source = { decoder, position: 0 };
                sources.set(synchronizationSource, source);
                decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
            }
            if (sequenceNumber !== undefined && source.sequence !== undefined) {
                const distance = (sequenceNumber - source.sequence) & 0xffff;
                if (distance === 0 || distance >= 0x8000)
                    return;
                source.position += (distance - 1) * 40000;
            }
            source.sequence = sequenceNumber;
            if (source.decoder.decodeQueueSize >= 10)
                return;
            source.decoder.decode(new EncodedAudioChunk({
                type: "key", timestamp: source.position, data: frame.data,
            }));
            source.position += 40000;
        }
        catch {
            close();
        }
    }
    return { playPacket, close };
}
function createPartyAudioClockWorker() {
    const workerScript = `self.onrtctransform = ({ transformer }) =>
    (${correctPartyAudioClock.toString()})(transformer, status => self.postMessage(status))
      .catch(() => self.postMessage("unsupported"));`;
    const url = URL.createObjectURL(new Blob([workerScript], { type: "text/javascript" }));
    try {
        return new Worker(url);
    }
    finally {
        URL.revokeObjectURL(url);
    }
}

const startNativeBridge = callable("start_native_bridge");
const answerNativeBridge = callable("answer_native_bridge");
const exchangeNativeBridge = callable("exchange_native_bridge");
function nativeBridgeChannels(session, incoming) {
    const commands = [];
    const channels = new Map();
    let nextKey = 0;
    class NativeChannel {
        constructor(key, label, id) {
            this.key = key;
            this.label = label;
            this.readyState = "connecting";
            this.binaryType = "arraybuffer";
            this.onopen = null;
            this.onmessage = null;
            this.id = id ?? null;
        }
        send(data) {
            if (this.readyState !== "open")
                return;
            const payload = typeof data === "string" ? { text: data } : { binary: btoa(String.fromCharCode(...data)) };
            commands.push({ type: "send", key: this.key, ...payload });
        }
        close() {
            if (this.readyState === "closed" || this.readyState === "closing")
                return;
            this.readyState = "closing";
            commands.push({ type: "close", key: this.key });
        }
    }
    function createChannel(label, options = {}) {
        const key = ++nextKey;
        const control = new NativeChannel(key, label, options.id);
        channels.set(key, control);
        commands.push({ type: "open", key, label, ordered: options.ordered ?? true, id: options.id, maxRetransmits: options.maxRetransmits });
        return control;
    }
    async function exchange() {
        const snapshot = await exchangeNativeBridge(session, commands.splice(0));
        for (const event of snapshot.events ?? []) {
            if (event.type === "incoming" && event.label !== undefined) {
                const channel = new NativeChannel(event.key, event.label, event.id);
                channels.set(event.key, channel);
                incoming(channel);
                continue;
            }
            const channel = channels.get(event.key);
            if (!channel)
                continue;
            if (event.type === "open" && channel.readyState === "connecting") {
                channel.readyState = "open";
                channel.id = event.id ?? channel.id;
                channel.onopen?.(new Event("open"));
            }
            else if (event.type === "close") {
                channel.readyState = "closed";
                channels.delete(event.key);
            }
            else if (event.type === "message" && channel.readyState === "open") {
                const data = event.text ?? Uint8Array.from(atob(event.binary ?? ""), letter => letter.charCodeAt(0)).buffer;
                channel.onmessage?.(new MessageEvent("message", { data }));
            }
        }
        return snapshot;
    }
    return { createChannel, exchange };
}

const startVoice = callable("start_voice");
const startBridgeVoice = callable("start_bridge_voice");
const answerBridgeVoice = callable("answer_bridge_voice");
const refreshBridgeOffer = callable("refresh_bridge_offer");
const bridgeVoicePeers = callable("bridge_voice_peers");
const voiceEvents = callable("voice_events");
const sendDescription = callable("send_voice_description");
const stopVoice = callable("stop_voice");
const setVoiceMute = callable("set_voice_mute");
function closePeer(peer) {
    peer.connection.onconnectionstatechange = null;
    peer.connection.ontrack = null;
    peer.connection.close();
    peer.clockWorker?.terminate();
    peer.opusPlayback?.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
}
function gatherCandidates(peer) {
    if (peer.iceGatheringState === "complete")
        return Promise.resolve();
    return new Promise(resolve => {
        function finish() {
            clearTimeout(timer);
            peer.removeEventListener("icegatheringstatechange", changed);
            resolve();
        }
        function changed() {
            if (peer.iceGatheringState === "complete")
                finish();
        }
        const timer = setTimeout(finish, 8000);
        peer.addEventListener("icegatheringstatechange", changed);
        changed();
    });
}
function partyVoiceSdp(sdp, narrowband = true) {
    return sdp.replace(/^m=audio\b[^\r\n]*(?:\r?\n(?!m=)[^\r\n]*)*/gm, media => {
        const opus = narrowband ? media.replace(/opus\/48000\/2/gi, "opus/16000/2") : media;
        if (/^a=ptime:\d+$/m.test(opus))
            return opus.replace(/^a=ptime:\d+$/m, "a=ptime:40");
        const newline = opus.includes("\r\n") ? "\r\n" : "\n";
        return opus.replace(/^(a=rtcp-mux)(?=\r?$)/m, `$1${newline}a=ptime:40`);
    });
}
function bridgeOfferForSteam(sdp) {
    return sdp.replace(/^m=audio\b[^\r\n]*(?:\r?\n(?!m=)[^\r\n]*)*/gm, media => {
        const opus = /^a=rtpmap:(\d+) opus\/(?:16000|48000)\/2(?=\r?$)/im.exec(media);
        if (!opus)
            return media;
        const payload = opus[1];
        const newline = media.includes("\r\n") ? "\r\n" : "\n";
        const formatLine = new RegExp(`^a=fmtp:${payload} ([^\\r\\n]*)`, "m");
        const settings = new Map((formatLine.exec(media)?.[1] ?? "").split(";").filter(Boolean).map(entry => {
            const [name, value] = entry.trim().split("=", 2);
            return [name, value];
        }));
        settings.set("stereo", "0");
        settings.set("maxaveragebitrate", "40000");
        settings.set("usedtx", "0");
        if (/opus\/16000\//i.test(opus[0])) {
            settings.set("maxplaybackrate", "16000");
            settings.set("sprop-maxcapturerate", "16000");
        }
        const format = `a=fmtp:${payload} ${[...settings].map(([name, value]) => `${name}=${value}`).join(";")}`;
        const mapping = `a=rtpmap:${payload} opus/48000/2`;
        const normalized = formatLine.test(media)
            ? media.replace(opus[0], mapping).replace(formatLine, format)
            : media.replace(opus[0], `${mapping}${newline}${format}`);
        return normalized.replace(/^a=(?:max)?ptime:\d+\r?\n/gm, "")
            .replace(mapping, `${mapping}${newline}a=ptime:40${newline}a=maxptime:40`);
    });
}
const voiceListeners = new Set();
let voiceSnapshot = { peerStates: {}, stopping: false, muted: false, start: async () => {}, stop: async () => {}, toggleMute: () => {} };
let partyBadge;
function useSharedPartyVoice() {
    return SP_REACT.useSyncExternalStore(listener => {
        voiceListeners.add(listener);
        return () => voiceListeners.delete(listener);
    }, () => voiceSnapshot);
}
function PartyVoiceHost() {
    const voice = usePartyVoice();
    SP_REACT.useEffect(() => {
        voiceSnapshot = voice;
        partyBadge?.update(voice.status?.connected && voice.activeParty ?
            (voice.bridgeStats?.peers ?? Object.values(voice.peerStates).filter(peer => peer.state === "connected").length) + 1 : 0);
        voiceListeners.forEach(listener => listener());
    }, [voice]);
    return null;
}
function usePartyVoice() {
    const active = SP_REACT.useRef(undefined);
    const [status, setStatus] = SP_REACT.useState();
    const [stopping, setStopping] = SP_REACT.useState(false);
    const [muted, setMuted] = SP_REACT.useState(false);
    const [muteError, setMuteError] = SP_REACT.useState();
    const [bridgeStats, setBridgeStats] = SP_REACT.useState();
    const [peerStates, setPeerStates] = SP_REACT.useState({});
    async function stop(message) {
        const call = active.current;
        if (!call)
            return;
        active.current = undefined;
        clearTimeout(call.timer);
        for (const peer of call.peers.values())
            closePeer(peer);
        call.mic?.getTracks().forEach(track => track.stop());
        if (call.audioContext)
            void call.audioContext.close().catch(() => { });
        if (!message)
            setBridgeStats(undefined);
        setStatus(message ? { party: call.party, text: message, error: true } : undefined);
        setStopping(true);
        try {
            if (call.signaling) {
                await call.signaling.catch(() => undefined);
                await stopVoice(call.party);
            }
        }
        catch {
            setStatus({ party: call.party, text: "Could not release the party voice session.", error: true });
        }
        finally {
            setStopping(false);
        }
    }
    SP_REACT.useEffect(() => () => { void stop(); }, []);
    function waitForVoice(call) {
        clearTimeout(call.timer);
        call.timer = setTimeout(() => {
            const waitingForReply = [...call.peers.values()].some(peer => peer.pendingOffer);
            void stop(call.lastPeerError ? `Direct party voice failed (PSN peer error ${call.lastPeerError}).` :
                waitingForReply ? "No PlayStation player replied to the voice offer." :
                    "No party audio connection was established in time.");
        }, 30000);
    }
    function updateStatus(call) {
        if (active.current !== call)
            return;
        const connected = (call.nativeBridgeState === undefined || call.nativeBridgeState === "connected") &&
            [...call.peers.values()].some(peer => peer.connection.connectionState === "connected");
        if (connected) {
            clearTimeout(call.timer);
            call.timer = undefined;
        }
        else if (!call.timer) {
            call.timer = setTimeout(() => { void stop("Party audio disconnected. Connect voice to try again."); }, 15000);
        }
        const waitingForReply = [...call.peers.values()].some(peer => peer.pendingOffer);
        const text = call.mode === "server"
            ? connected ? "Sony voice bridge connected" : "Connecting to Sony’s voice bridge…"
            : connected ? "Party voice connected" :
                waitingForReply ? "Waiting for a PlayStation voice reply…" :
                    call.peers.size ? "Connecting party audio…" : "Waiting for another party member…";
        setStatus({ party: call.party, connected, text });
        if (call.mode !== "server")
            setPeerStates(Object.fromEntries([...call.peers].map(([id, peer]) => [id, {
                muted: call.memberMutes?.[id],
                state: peer.connection.connectionState === "connected" ? "connected" :
                    peer.connection.connectionState === "failed" ? "failed" : "connecting",
            }])));
    }
    function createPeer(call, account, stream, nativeAudio = false) {
        const legacyClock = call.mode === "server" && !nativeAudio && (call.audioContext || typeof RTCRtpScriptTransform === "undefined") &&
            typeof RTCRtpReceiver.prototype.createEncodedStreams === "function" &&
            typeof RTCRtpSender.prototype.createEncodedStreams === "function";
        const configuration = {
            iceServers: nativeAudio ? [] : [{ urls: "stun:stun.cloudflare.com:3478" }],
        };
        if (legacyClock)
            configuration.encodedInsertableStreams = true;
        const connection = new RTCPeerConnection(configuration);
        const audio = new Audio();
        const peer = { connection, audio };
        if (legacyClock && call.audioContext) {
            peer.opusPlayback = createOpusPlayback(call.audioContext, audio, () => { peer.decodingOpus = true; });
        }
        call.peers.set(account, peer);
        connection.onconnectionstatechange = () => {
            if (connection.connectionState === "failed" && !nativeAudio) {
                if ([...call.peers.values()].every(item => item.connection.connectionState === "failed")) {
                    void stop(call.mode === "server" ? "The Sony voice bridge connection failed." :
                        "No direct audio connection could be established with the party.");
                    return;
                }
            }
            updateStatus(call);
        };
        const attachedReceivers = new WeakSet();
        function attachClock(receiver) {
            if (attachedReceivers.has(receiver))
                return;
            attachedReceivers.add(receiver);
            try {
                if (legacyClock) {
                    const streams = receiver.createEncodedStreams();
                    void correctPartyAudioClock(streams, status => { peer.clockCorrection = status; }, peer.opusPlayback?.playPacket)
                        .catch(() => { peer.clockCorrection = "unsupported"; });
                }
                else if (peer.clockWorker) {
                    receiver.transform = new RTCRtpScriptTransform(peer.clockWorker);
                }
            }
            catch {
                peer.clockCorrection = "unsupported";
            }
        }
        if (call.mode === "server" && !legacyClock && !nativeAudio) {
            try {
                if (typeof RTCRtpScriptTransform !== "undefined") {
                    peer.clockWorker = createPartyAudioClockWorker();
                    peer.clockWorker.onmessage = ({ data }) => { peer.clockCorrection = data; };
                    peer.clockWorker.onerror = () => { peer.clockCorrection = "unsupported"; };
                }
                else
                    peer.clockCorrection = "unsupported";
            }
            catch {
                peer.clockCorrection = "unsupported";
            }
        }
        connection.ontrack = ({ track, streams, receiver }) => {
            if (track.kind !== "audio" || active.current !== call)
                return;
            attachClock(receiver);
            audio.srcObject = streams[0] ?? new MediaStream([track]);
            void audio.play().catch(() => {
                if (active.current === call)
                    void stop("Steam blocked party audio playback.");
            });
        };
        for (const track of stream.getAudioTracks()) {
            const sender = connection.addTrack(track, stream);
            if (legacyClock) {
                const streams = sender.createEncodedStreams();
                void correctMicrophoneClock(streams, () => peer.narrowband === true, status => { peer.microphoneClock = status; })
                    .catch(() => { peer.microphoneClock = "unsupported"; });
            }
        }
        for (const receiver of connection.getReceivers())
            attachClock(receiver);
        return peer;
    }
    async function answerBridge(call, peer, offer) {
        const narrowband = /opus\/16000\/2/i.test(offer);
        peer.narrowband = narrowband;
        if (narrowband && !("createEncodedStreams" in RTCRtpSender.prototype))
            peer.microphoneClock = "unsupported";
        await peer.connection.setRemoteDescription({ type: "offer", sdp: bridgeOfferForSteam(offer) });
        await peer.connection.setLocalDescription(await peer.connection.createAnswer());
        await gatherCandidates(peer.connection);
        if (active.current !== call)
            return;
        const answer = peer.connection.localDescription?.sdp;
        if (!answer)
            throw new Error("Steam could not generate a Sony voice bridge answer.");
        await answerBridgeVoice(call.party, partyVoiceSdp(answer, narrowband));
    }
    async function runBridge(call, stream, { offer, account, peer: bridgePeer, signalingId }, useNative = true) {
        let peer;
        let native;
        let nativeAnswer;
        if (useNative && /opus\/16000\/2/i.test(offer)) {
            peer = createPeer(call, "bridge", stream, true);
            await peer.connection.setLocalDescription(await peer.connection.createOffer());
            await gatherCandidates(peer.connection);
            if (active.current !== call)
                return;
            const localOffer = peer.connection.localDescription?.sdp;
            if (!localOffer)
                throw new Error("Steam could not open local party audio.");
            const startup = startNativeBridge(call.party, offer, localOffer);
            call.signaling = startup;
            const result = await startup;
            if (active.current !== call)
                return;
            if (result) {
                nativeAnswer = result.answer;
                call.nativeBridgeState = "connecting";
                await peer.connection.setRemoteDescription({ type: "answer", sdp: bridgeOfferForSteam(result.localAnswer) });
            }
            else {
                closePeer(peer);
                call.peers.delete("bridge");
            }
        }
        peer = call.peers.get("bridge") ?? createPeer(call, "bridge", stream);
        if (nativeAnswer)
            native = nativeBridgeChannels(call.party, acceptPeerControl);
        const createChannel = native?.createChannel ?? peer.connection.createDataChannel.bind(peer.connection);
        const channel = createChannel("bridge");
        async function applyOffer(sdp) {
            if (!native) {
                await answerBridge(call, peer, sdp);
                return;
            }
            const answer = nativeAnswer ?? await answerNativeBridge(call.party, sdp);
            nativeAnswer = undefined;
            if (active.current === call)
                await answerBridgeVoice(call.party, partyVoiceSdp(answer, false));
        }
        const encoder = new TextEncoder();
        const hello = encoder.encode("hello");
        const user = { account_id: account, platform: 100001 };
        if (typeof signalingId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(signalingId))
            throw new Error("Sony did not provide this device’s signaling identity.");
        let userTableSequence = 0;
        const controlPeers = new Map();
        const peerAccounts = new Map();
        const peerMutes = new Map();
        const peerFirstSeen = new Map();
        const openPeerAfter = new Map();
        function registerPeerControl(id, control, openedLocally) {
            const entry = { channel: control, openedLocally, ready: false, announced: false, helloAttempts: 0 };
            controlPeers.set(id, entry);
            control.binaryType = "arraybuffer";
            function onOpen() {
                const now = Date.now();
                entry.helloAt = now + (openedLocally ? 3000 : 0);
                // An open relay can deliver the announcement even if the hello reply was lost.
                entry.announceAt = now + 5000;
            }
            control.onopen = onOpen;
            if (control.readyState === "open")
                onOpen();
            control.onmessage = ({ data }) => {
                const message = typeof data === "string" ? data : new TextDecoder().decode(data);
                if (control.readyState !== "open")
                    return;
                if (message !== "hello") {
                    if (message.length > 65536)
                        return;
                    try {
                        const update = JSON.parse(message);
                        if (update.type === "user_table_updated" && update.peer?.bridge_peer_id === id) {
                            const accounts = (update.peer.users ?? []).map(user => String(user.account_id ?? "").replace(/^0+(?=\d)/, "")).filter(Boolean);
                            if (accounts.length)
                                peerAccounts.set(id, accounts);
                        }
                        if (!entry.announced && update.type === "user_table_updated" && update.peer?.bridge_peer_id === id) {
                            entry.announced = true;
                            entry.announceAt = Date.now() + 1000;
                        }
                    }
                    catch {
                        // Other control payloads are unrelated to the user table.
                    }
                    return;
                }
                // The peer accepting the data channel sends hello. Its creator echoes it.
                if (openedLocally)
                    control.send(hello);
                if (entry.ready)
                    return;
                entry.ready = true;
                entry.announceAt = Date.now() + 1000;
            };
        }
        function announceMicrophone(control) {
            control.send(encoder.encode(JSON.stringify({
                type: "user_table_updated",
                global_seq_num: ++userTableSequence,
                peer: {
                    peer_id: signalingId,
                    bridge_peer_id: bridgePeer,
                    miranda_signaling_version: 2,
                    users: [user],
                    medias: [{
                            user,
                            media_records: [{ mid: "", media_identifier: "voice_chat" }],
                            msids: [""],
                        }],
                },
            })));
        }
        function acceptPeerControl(control) {
            const match = /^([A-Za-z0-9_-]{1,128})_0$/.exec(control.label);
            if (!match)
                return;
            const id = match[1];
            const previous = controlPeers.get(id);
            if (previous?.channel.readyState === "open" && previous.ready) {
                control.close();
                return;
            }
            previous?.channel.close();
            registerPeerControl(id, control, false);
        }
        if (!native)
            peer.connection.ondatachannel = ({ channel: control }) => acceptPeerControl(control);
        let offerUpdated = false;
        let pendingOffer;
        let answeredOffer = offer;
        let peersChanged = true;
        let refreshPeersAt = 0;
        let subscribed;
        let subscription;
        let subscriptionDeadline = 0;
        let sentAsText = false;
        let controlMessages = 0;
        let refreshOfferAt = 0;
        let remotePeerCount;
        let nextRequestId = 0;
        let lastSource;
        let receiveClock;
        function requestSubscription(peers, asText) {
            const request = JSON.stringify({
                category: "request", type: "setMediaPubSubPeers", id: ++nextRequestId,
                payload: { mediaSubscriptionPeers: peers, mediaPublishmentPeers: peers },
            });
            if (asText)
                channel.send(request);
            else
                channel.send(new TextEncoder().encode(request));
            subscribed = peers;
            subscription = "pending";
            sentAsText = asText;
            subscriptionDeadline = Date.now() + 8000;
            refreshOfferAt = 0;
        }
        channel.binaryType = "arraybuffer";
        channel.onmessage = ({ data }) => {
            controlMessages += 1;
            try {
                const event = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
                const type = event.eventType ?? event.type;
                if (type === "dataChannelCreated") {
                    const { peer: remote, dataChannel: relay } = event.payload ?? event;
                    const sid = typeof relay?.sid === "number" || /^\d+$/.test(relay?.sid ?? "") ? Number(relay.sid) : NaN;
                    const id = remote?.peerId;
                    if (typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) && id !== bridgePeer &&
                        relay?.label === `${bridgePeer}_0` && Number.isInteger(sid) &&
                        sid >= 0 && sid < 65535 &&
                        [0, 1, 128, 129].includes(relay.channelType)) {
                        const previous = controlPeers.get(id);
                        if (previous?.channel.id !== sid && !previous?.ready) {
                            const control = createChannel(`${id}_0`, {
                                negotiated: true,
                                id: sid,
                                ordered: (relay.channelType & 128) === 0,
                                maxRetransmits: (relay.channelType & 127) === 1 ? relay.reliabilityParameter ?? 0 : undefined,
                            });
                            previous?.channel.close();
                            registerPeerControl(id, control, false);
                        }
                    }
                    return;
                }
                if (type === "offerUpdated") {
                    const sdp = (event.payload?.offer ?? event.offer)?.sdp;
                    if (typeof sdp === "string" && sdp.startsWith("v=0") && sdp.length <= 65536)
                        pendingOffer = sdp;
                    else
                        offerUpdated = true;
                }
                if (event.category === "response" && type === "setMediaPubSubPeers"
                    && String(event.id) === String(nextRequestId)) {
                    const peers = event.payload?.mediaSubscriptionPeers;
                    const publication = event.payload?.mediaPublishmentPeers;
                    const expected = JSON.stringify(subscribed);
                    if (Array.isArray(peers) && JSON.stringify([...peers].sort()) === expected
                        && Array.isArray(publication) && JSON.stringify([...publication].sort()) === expected) {
                        subscription = "accepted";
                        refreshOfferAt = peers.length ? Date.now() + 2000 : 0;
                    }
                    else {
                        subscription = "peer-mismatch";
                    }
                }
                if (type === "peerCreated" || type === "peerDeleted")
                    peersChanged = true;
            }
            catch {
                // The channel can also carry messages unrelated to media subscriptions.
            }
        };
        await applyOffer(offer);
        if (active.current === call) {
            try {
                await setVoiceMute(call.party, !stream.getAudioTracks()[0].enabled);
            } catch {
                setMuteError("Could not share microphone mute status. Toggle mute to retry.");
            }
        }
        if (active.current !== call)
            return;
        waitForVoice(call);
        updateStatus(call);
        const audioMedia = offer.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "));
        let needsDownlinkOffer = Boolean(audioMedia && /^a=recvonly$/m.test(audioMedia));
        const nativeDeadline = Date.now() + 35000;
        let nativeConnected = false;
        while (active.current === call) {
            const nativeStats = await native?.exchange();
            if (active.current !== call)
                return;
            if (nativeStats?.state === "connected" && peer.connection.connectionState === "connected") {
                nativeConnected = true;
            }
            if (nativeStats && !nativeConnected && (nativeStats.state === "failed" || nativeStats.state === "closed" ||
                peer.connection.connectionState === "failed" || Date.now() >= nativeDeadline)) {
                closePeer(peer);
                call.peers.delete("bridge");
                call.nativeBridgeState = undefined;
                clearTimeout(call.timer);
                call.timer = undefined;
                setStatus({ party: call.party, text: "Retrying Sony voice with Steam…" });
                const reopening = (async () => {
                    await stopVoice(call.party);
                    if (active.current === call)
                        return startBridgeVoice(call.party);
                })();
                call.signaling = reopening;
                const fallback = await reopening;
                if (fallback && active.current === call)
                    await runBridge(call, stream, fallback, false);
                return;
            }
            if (nativeStats && (nativeStats.state === "failed" || nativeStats.state === "closed" ||
                peer.connection.connectionState === "failed")) {
                throw new Error("The native Sony voice connection failed.");
            }
            if (nativeStats && call.nativeBridgeState !== nativeStats.state) {
                call.nativeBridgeState = nativeStats.state;
                updateStatus(call);
            }
            if (channel.readyState === "open" && (peersChanged || Date.now() >= refreshPeersAt)) {
                peersChanged = false;
                refreshPeersAt = Date.now() + 2000;
                const bridgePeers = await bridgeVoicePeers(call.party);
                if (active.current !== call)
                    return;
                const mediaSubscriptionPeers = bridgePeers.map(({ id }) => id);
                remotePeerCount = mediaSubscriptionPeers.length;
                const knownPeers = new Set(mediaSubscriptionPeers);
                for (const [id, entry] of controlPeers) {
                    if (!knownPeers.has(id)) {
                        entry.channel.close();
                        controlPeers.delete(id);
                        peerAccounts.delete(id);
                        peerMutes.delete(id);
                        peerFirstSeen.delete(id);
                    }
                }
                for (const id of openPeerAfter.keys()) {
                    if (!knownPeers.has(id))
                        openPeerAfter.delete(id);
                }
                for (const { id, identity, account, muted } of bridgePeers) {
                    if (typeof muted === "boolean")
                        peerMutes.set(id, muted);
                    if (account)
                        peerAccounts.set(id, [account]);
                    if (!peerFirstSeen.has(id))
                        peerFirstSeen.set(id, Date.now());
                    // Miranda assigns the lower signaling peer ID the initiating role.
                    if (!openPeerAfter.has(id)) {
                        const waitsForPeer = identity && signalingId.toLowerCase() >= identity.toLowerCase();
                        openPeerAfter.set(id, Date.now() + (waitsForPeer ? 6000 : identity ? 0 : 3000));
                    }
                }
                if (JSON.stringify(subscribed) !== JSON.stringify(mediaSubscriptionPeers) && channel.readyState === "open") {
                    requestSubscription(mediaSubscriptionPeers, sentAsText && subscription === "accepted");
                }
            }
            if (channel.readyState === "open") {
                for (const [id, openAt] of openPeerAfter) {
                    const entry = controlPeers.get(id);
                    if ((!entry || entry.channel.readyState === "closed") && Date.now() >= openAt) {
                        registerPeerControl(id, createChannel(`${id}_0`, { ordered: true, maxRetransmits: 0 }), true);
                        openPeerAfter.set(id, Date.now() + 8000);
                    }
                    else if (entry?.channel.readyState === "open") {
                        const now = Date.now();
                        if (!entry.ready && !entry.announced && entry.helloAt !== undefined &&
                            now >= entry.helloAt && entry.helloAttempts < 3) {
                            entry.channel.send(hello);
                            entry.helloAttempts++;
                            entry.helloAt = now + 3000;
                        }
                        if (entry.announceAt !== undefined && now >= entry.announceAt) {
                            announceMicrophone(entry.channel);
                            entry.announceAt = undefined;
                        }
                    }
                }
            }
            if (subscription === "pending" && Date.now() >= subscriptionDeadline) {
                if (!sentAsText && subscribed && channel.readyState === "open")
                    requestSubscription(subscribed, true);
                else
                    subscription = "no-reply";
            }
            if (pendingOffer || offerUpdated || (needsDownlinkOffer && refreshOfferAt && Date.now() >= refreshOfferAt)) {
                const embedded = pendingOffer;
                pendingOffer = undefined;
                offerUpdated = false;
                refreshOfferAt = 0;
                const refreshed = embedded ?? await refreshBridgeOffer(call.party);
                if (active.current !== call)
                    return;
                if (refreshed !== answeredOffer) {
                    await applyOffer(refreshed);
                    answeredOffer = refreshed;
                    for (const entry of controlPeers.values()) {
                        if (entry.ready)
                            entry.announceAt = Date.now() + 1000;
                    }
                    const refreshedAudio = refreshed.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "));
                    needsDownlinkOffer = Boolean(refreshedAudio && /^a=recvonly$/m.test(refreshedAudio));
                }
            }
            const report = await peer.connection.getStats();
            if (active.current !== call)
                return;
            let sent = 0;
            let received = 0;
            let concealedSamples = 0;
            let remoteAudioReport = false;
            let microphoneLevel;
            report.forEach(stat => {
                if (stat.kind !== "audio" && stat.mediaType !== "audio")
                    return;
                if (stat.type === "outbound-rtp")
                    sent += stat.packetsSent ?? 0;
                if (stat.type === "inbound-rtp") {
                    received += stat.packetsReceived ?? 0;
                    concealedSamples += stat.concealedSamples ?? 0;
                }
                if (stat.type === "remote-inbound-rtp")
                    remoteAudioReport = true;
                if (stat.type === "media-source" && typeof stat.audioLevel === "number") {
                    microphoneLevel = Math.round(stat.audioLevel * 100);
                }
            });
            const source = peer.connection.getReceivers().find(receiver => receiver.track.kind === "audio")
                ?.getSynchronizationSources()[0];
            if (!source || performance.now() - source.timestamp > 1500) {
                lastSource = undefined;
                receiveClock = undefined;
            }
            else if (lastSource?.source !== source.source) {
                lastSource = source;
                receiveClock = undefined;
            }
            else if (source.timestamp - lastSource.timestamp >= 900) {
                const ticks = (source.rtpTimestamp - lastSource.rtpTimestamp) >>> 0;
                receiveClock = Math.round(ticks / (source.timestamp - lastSource.timestamp));
                lastSource = source;
            }
            const states = {};
            for (const [id, firstSeen] of peerFirstSeen) {
                const state = bridgePeerState(controlPeers.get(id), subscription, Date.now(), firstSeen);
                for (const account of peerAccounts.get(id) ?? [])
                    states[account] = { state, muted: peerMutes.get(id) };
            }
            if (active.current !== call)
                return;
            setPeerStates(states);
            setBridgeStats({
                sent: nativeStats?.sent ?? sent, received: nativeStats?.received ?? received,
                peers: remotePeerCount, subscription, controlMessages,
                receiveClock, concealedMs: Math.round(concealedSamples / 48),
                remoteAudioReport: nativeStats?.remoteAudioReport ?? remoteAudioReport,
                clockCorrection: peer.clockCorrection,
                decodingOpus: peer.decodingOpus && peer.audio.muted,
                microphoneLevel,
                microphoneClock: nativeStats?.sent ? "correcting" : peer.narrowband ? peer.microphoneClock : undefined,
                readyPeers: [...controlPeers.values()].filter(entry => entry.ready && entry.channel.readyState === "open").length,
                openControlPeers: [...controlPeers.values()].filter(entry => entry.channel.readyState === "open").length,
                announcingPeers: [...controlPeers.values()].filter(entry => entry.announced && entry.channel.readyState === "open").length,
            });
            await new Promise(resolve => setTimeout(resolve, native ? 250 : 1000));
        }
    }
    async function sendLocal(call, account, peer, type, sequence) {
        await gatherCandidates(peer.connection);
        if (active.current !== call)
            return;
        const sdp = peer.connection.localDescription?.sdp;
        if (!sdp)
            throw new Error("Steam could not generate party voice signaling.");
        await sendDescription(call.party, account, { type, sequence, sdp: partyVoiceSdp(sdp) });
    }
    async function poll(call, stream) {
        while (active.current === call) {
            const { members, descriptions, muted } = await voiceEvents(call.party);
            call.memberMutes = muted;
            if (active.current !== call)
                return;
            for (const [account, peer] of call.peers) {
                if (!members.includes(account)) {
                    closePeer(peer);
                    call.peers.delete(account);
                }
            }
            for (const message of descriptions) {
                const { account, type } = message;
                const peer = call.peers.get(account);
                if (type === "error") {
                    if (peer?.pendingOffer) {
                        call.lastPeerError = message.code;
                        if (!peer.retried) {
                            peer.retried = true;
                            peer.pendingOffer = "2";
                            waitForVoice(call);
                            await peer.connection.setLocalDescription(await peer.connection.createOffer({ iceRestart: true }));
                            await sendLocal(call, account, peer, "offer", "2");
                        }
                    }
                    if (active.current !== call)
                        return;
                    continue;
                }
                const { sequence } = message;
                const sdp = message.sdp.replace(/opus\/16000\/2/gi, "opus/48000/2");
                if (type === "answer") {
                    if (peer?.pendingOffer === sequence && peer.connection.signalingState === "have-local-offer") {
                        await peer.connection.setRemoteDescription({ type, sdp });
                        peer.pendingOffer = undefined;
                    }
                }
                else {
                    // The Deck yields to remote offers if both players offer at once.
                    const incoming = peer ?? createPeer(call, account, stream);
                    await incoming.connection.setRemoteDescription({ type, sdp });
                    incoming.pendingOffer = undefined;
                    await incoming.connection.setLocalDescription(await incoming.connection.createAnswer());
                    await sendLocal(call, account, incoming, "answer", sequence);
                }
                if (active.current !== call)
                    return;
            }
            await Promise.all(members.filter(account => !call.peers.has(account)).map(async (account) => {
                const peer = createPeer(call, account, stream);
                peer.pendingOffer = "1";
                peer.connection.createDataChannel("voice");
                await peer.connection.setLocalDescription(await peer.connection.createOffer());
                await sendLocal(call, account, peer, "offer", "1");
            }));
            if (active.current !== call)
                return;
            updateStatus(call);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    async function start(party, mode = "server") {
        if (active.current || stopping)
            return;
        if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
            setStatus({ party, text: "Microphone or WebRTC access is unavailable in this Steam session.", error: true });
            return;
        }
        const call = { party, mode, peers: new Map(), startedAt: Date.now() };
        if (mode === "server" && typeof AudioDecoder === "function" && typeof AudioContext === "function" &&
            typeof RTCRtpReceiver.prototype.createEncodedStreams === "function") {
            try {
                call.audioContext = new AudioContext();
                void call.audioContext.resume().catch(() => { });
            }
            catch {
                // The WebRTC audio element remains available.
            }
        }
        active.current = call;
        setPeerStates({});
        setMuted(false);
        setMuteError(undefined);
        setBridgeStats(undefined);
        setStatus({ party, text: "Waiting for microphone access…" });
        call.timer = setTimeout(() => { void stop("Steam did not grant microphone access in time."); }, 15000);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
            });
            if (active.current !== call) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            clearTimeout(call.timer);
            call.mic = stream;
            if (mode === "server") {
                setStatus({ party, text: "Opening Sony’s voice bridge…" });
                const opening = startBridgeVoice(party);
                call.signaling = opening;
                const offer = await opening;
                if (active.current === call)
                    await runBridge(call, stream, offer);
                return;
            }
            setStatus({ party, text: "Connecting to Sony’s party signaling server…" });
            call.signaling = startVoice(party);
            await call.signaling;
            if (active.current !== call)
                return;
            try {
                await setVoiceMute(call.party, !stream.getAudioTracks()[0].enabled);
            } catch {
                setMuteError("Could not share microphone mute status. Toggle mute to retry.");
            }
            waitForVoice(call);
            await poll(call, stream);
        }
        catch (error) {
            if (active.current === call) {
                const detail = error instanceof Error ? error.message : String(error);
                await stop(`Could not connect to party voice. ${detail}`);
            }
        }
    }
    function toggleMute() {
        const call = active.current;
        const track = call?.mic?.getAudioTracks()[0];
        if (!track)
            return;
        const nextMuted = track.enabled;
        track.enabled = !nextMuted;
        call.muted = nextMuted;
        setMuted(nextMuted);
        setMuteError(undefined);
        call.muteUpdate = (call.muteUpdate ?? Promise.resolve()).then(async () => {
            if (active.current === call)
                await setVoiceMute(call.party, nextMuted);
        }).then(() => {
            if (active.current === call && call.muted === nextMuted)
                setMuteError(undefined);
        }).catch(() => {
            if (active.current === call && call.muted === nextMuted)
                setMuteError("Could not share microphone mute status. Toggle mute to retry.");
        });
    }
    return { start, stop, status, bridgeStats, peerStates, startedAt: active.current?.startedAt, activeParty: active.current?.party, stopping, muted, muteError, toggleMute };
}

const api = {
    avatarImage: callable("avatar_image"),
    load: callable("load"),
    signIn: callable("sign_in"),
    signOut: callable("sign_out"),
    search: callable("search"),
    relationships: callable("relationships"),
    inbox: callable("inbox"),
    createChat: callable("create_chat"),
    messages: callable("messages"),
    send: callable("send_message"),
    parties: callable("parties"),
    createParty: callable("create_party"),
    join: callable("join_party"),
    leave: callable("leave_party"),
    invite: callable("invite"),
};
function useTask() {
    const pending = SP_REACT.useRef(false);
    const [busy, setBusy] = SP_REACT.useState(false);
    const [error, setError] = SP_REACT.useState("");
    async function run(task) {
        if (pending.current)
            return;
        pending.current = true;
        setBusy(true);
        setError("");
        try {
            await task();
        }
        catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        }
        finally {
            pending.current = false;
            setBusy(false);
        }
    }
    return { run, busy, error };
}
const rowStyles = `
  .psn-social-header { margin: 0 12px 8px; padding: 12px; background: #23272a; border-radius: 8px; }
  .psn-social-profile { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .psn-social-profile-avatar { flex: 0 0 42px; height: 42px; display: grid; place-items: center; position: relative; border-radius: 50%; background: #414846; font-weight: 700; }
  .psn-social-profile-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
  .psn-social-profile-copy { min-width: 0; }
  .psn-social-profile-copy strong { color: #f8f9fa; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .psn-social-profile-meta { display: flex; gap: 6px 10px; flex-wrap: wrap; font-size: 12px; color: #c3cad1; margin-top: 2px; }
  .psn-social-profile-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
  .psn-social-trophy { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
  .psn-social-nav { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
  .psn-social-nav .psn-social-action-start { margin-inline-start: auto; }
  .psn-social-nav .psn-social-control { width: 32px !important; min-width: 0 !important; height: 32px; min-height: 0; padding: 0 !important; flex: 0 0 32px; display: grid; place-items: center; border-radius: 4px; }
  .psn-social-nav .psn-social-control.psn-social-active {
    background: #fff !important;
    color: #0e141b !important;
    box-shadow: none !important;
  }
  .psn-social-nav .psn-social-active svg { color: #0e141b !important; }
  .psn-social-nav .psn-social-active:is(.gpfocus, :focus-visible) {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  .psn-social-header-alert, .psn-social-header-status { margin: 8px 0 0; font-size: 12px; overflow-wrap: anywhere; }
  .psn-social-header-alert { color: #e2c4a2; }
  .psn-social-header-status { color: #c3cad1; }

  .psn-social-list { margin: 0 6px 12px; }
  .psn-social-list h2 { margin: 0; font-size: 16px; font-weight: 650; }
  .psn-social-group { margin: 16px 0 8px; }
  .psn-social-group h3 { margin: 0 0 6px; font-size: 14px; font-weight: 650; }
  .psn-social-group h3 span { margin-left: 6px; color: #b8c0ca; font-weight: 400; }
  .psn-social-group > .psn-social-row + .psn-social-row { margin-block-start: 6px; }
  .psn-social-entry { box-sizing: border-box; padding: 6px !important; background: #25282c; border-radius: 4px; width: 100%; min-width: 0; min-height: 48px; color: #f8f9fa; }
  .psn-social-entry:is(:focus, :focus-visible, .gpfocus) { background: #353d36; outline: 2px solid #78cf45; outline-offset: -2px; }
  .psn-social-player { display: flex; gap: 7px; align-items: center; min-width: 0; width: 100%; text-align: left; }
  .psn-social-player-avatar { width: 36px; height: 36px; flex: 0 0 36px; display: grid; place-items: center; position: relative; border-radius: 50%; background: #414846; color: #fff; font-size: 16px; font-weight: 700; }
  .psn-social-avatar-muted { position: absolute; inset: 0; z-index: 2; border-radius: 50%; background: #0e141ba6; color: white; display: grid; place-items: center; }
  .psn-social-party-member { padding: 6px 4px; border-radius: 4px; }
  .psn-social-party-member.psn-social-you { background: rgba(102, 192, 244, 0.14); box-shadow: inset 2px 0 0 #66c0f4; }
  .psn-social-party-member .psn-social-player { gap: 10px; }
  .psn-social-party-member .psn-social-player-copy strong { font-weight: 700; }
  .psn-social-party-member .psn-social-player-copy { line-height: 1.4; }
  .psn-social-player-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
  .psn-social-player-copy { flex: 1; min-width: 0; line-height: 1.4; }
  .psn-social-player-copy > * { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .psn-social-player-copy strong { font-size: 14px; font-weight: 650; }
  .psn-social-player-subtitle { font-size: 12px; color: #c3cad1; }
  .psn-social-entry:is(:focus, :focus-visible, .gpfocus) .psn-social-player-subtitle { color: inherit; }
  .psn-social-presence { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border: 2px solid #25282c; border-radius: 50%; box-sizing: border-box; }
`;
function playerPresence(player) {
    switch (player.status?.toLowerCase()) {
        case "online": return "Online";
        case "offline": return "Offline";
        case "away": return "Away";
        default: return "Unknown";
    }
}
function presenceTone(player) {
    const presence = playerPresence(player);
    return presence === "Online" ? "#78cf45" : presence === "Away" ? "#ffc95f" : "#a0a8b1";
}
function ProfileAvatar({ player, showPresence }) {
    const [failedAvatars, setFailedAvatars] = SP_REACT.useState([]);
    const [fallback, setFallback] = SP_REACT.useState();
    const primary = player.avatar ?? player.avatars?.[0];
    const avatar = [primary, ...(player.avatars ?? [])].find(url => url && !failedAvatars.includes(url));
    const fallbackImage = fallback?.url === primary ? fallback?.image : undefined;
    const candidates = JSON.stringify([...new Set([primary, ...(player.avatars ?? [])].filter(Boolean))]);
    SP_REACT.useEffect(() => {
        if (avatar || !primary)
            return;
        let active = true;
        async function fetchFallback() {
            const urls = JSON.parse(candidates);
            for (const url of urls) {
                if (!active)
                    return;
                const image = await api.avatarImage(url).catch(() => null);
                if (active && image && primary) {
                    setFallback({ url: primary, image });
                    return;
                }
            }
        }
        void fetchFallback();
        return () => { active = false; };
    }, [avatar, primary, candidates]);
    return SP_REACT.createElement("span", { className: showPresence ? "psn-social-player-avatar" : "psn-social-profile-avatar", "aria-hidden": player.muted || player.voiceError ? undefined : "true" },
        Array.from(player.name)[0]?.toUpperCase(),
        avatar && SP_REACT.createElement("img", { key: avatar, src: avatar, alt: "", referrerPolicy: "no-referrer", onError: () => setFailedAvatars(previous => [...previous, avatar]) }),
        !avatar && fallbackImage && SP_REACT.createElement("img", { src: fallbackImage, alt: "", onError: event => { event.currentTarget.hidden = true; } }),
        (player.muted || player.voiceError) && SP_REACT.createElement("span", { className: "psn-social-avatar-muted", role: "img", "aria-label": player.voiceError ? "Microphone connection error" : "Microphone muted" },
            SP_REACT.createElement("svg", { width: 25, height: 25, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", "aria-hidden": true },
                SP_REACT.createElement("path", { d: player.voiceError ? "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3M5 11v1a7 7 0 007 7m0 0v3m-3 0h6M17 16l5 5m0-5-5 5" : "M3 3l18 18M9 9v3a3 3 0 005 2M15 9V5a3 3 0 00-6 0M5 10v2a7 7 0 0012 5M19 10v2M12 19v3M8 22h8" }))),
        showPresence && !player.voiceState && SP_REACT.createElement("span", { className: "psn-social-presence", style: { background: presenceTone(player) } }));
}
function PartyRowButton({ label, disabled, onClick, children }) {
    return SP_REACT.createElement(DFL.DialogButton, { "aria-label": label, onOKActionDescription: label, disabled, onClick,
        style: { width: 32, height: 32, minWidth: 0, minHeight: 0, padding: 0, display: "grid", placeItems: "center" } },
        SP_REACT.createElement("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8,
            strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
            SP_REACT.createElement("title", null, label), children));
}
function PartyCreateButtons({ disabled, create }) {
    return SP_REACT.createElement(DFL.Focusable, { "flow-children": "row", style: { display: "flex", gap: 6 } },
        SP_REACT.createElement(PartyRowButton, { label: "Create invite-only party", disabled, onClick: () => create(false) },
            SP_REACT.createElement("rect", { x: 5, y: 10, width: 14, height: 11, rx: 2 }),
            SP_REACT.createElement("path", { d: "M8 10V7a4 4 0 018 0v3m-4 5v2" })),
        SP_REACT.createElement(PartyRowButton, { label: "Create friends-only party", disabled, onClick: () => create(true) },
            SP_REACT.createElement("circle", { cx: 9, cy: 7, r: 3 }),
            SP_REACT.createElement("path", { d: "M3 21v-3a6 6 0 0112 0v3m1-17a3 3 0 010 6m2 4a5 5 0 013 4v3" })));
}
function PartyMemberRow({ player, action }) {
    return SP_REACT.createElement("div", { className: `psn-social-party-member${player.self ? " psn-social-you" : ""}` },
        SP_REACT.createElement("span", { className: "psn-social-player" },
            SP_REACT.createElement(ProfileAvatar, { player, showPresence: true }),
            SP_REACT.createElement("span", { className: "psn-social-player-copy" },
                SP_REACT.createElement("strong", null, player.name),
                SP_REACT.createElement("span", { className: "psn-social-player-subtitle", role: "status" },
                    player.detail ?? [playerPresence(player), player.game].filter(Boolean).join(" · "))),
            action));
}
function PlayerRow({ player, detail, action, disabled }) {
    const presence = playerPresence(player);
    const content = SP_REACT.createElement("span", { className: "psn-social-player" },
        SP_REACT.createElement(ProfileAvatar, { player: player, showPresence: true }),
        SP_REACT.createElement("span", { className: "psn-social-player-copy" },
            player.fullName && SP_REACT.createElement("span", { className: "psn-social-player-subtitle", title: player.name }, player.name),
            SP_REACT.createElement("strong", { title: player.fullName ?? player.name }, player.fullName ?? player.name),
            SP_REACT.createElement("span", { className: "psn-social-player-subtitle" }, detail ?? [presence, player.game].filter(Boolean).join(" · "))));
    return SP_REACT.createElement("div", { className: "psn-social-row" }, action
        ? SP_REACT.createElement(DFL.DialogButton, { className: "psn-social-entry", onClick: action, disabled: disabled }, content)
        : SP_REACT.createElement("div", { className: "psn-social-entry" }, content));
}
function Dialog({ closeModal, title, children }) {
    return SP_REACT.createElement(WideModal, { closeModal: closeModal },
        SP_REACT.createElement(DFL.Focusable, { "flow-children": "column", style: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0, maxHeight: "70vh", overflowY: "auto" }, onFocus: event => { if (event.currentTarget !== event.target)
                event.target.scrollIntoView({ block: "nearest" }); } },
            SP_REACT.createElement("style", null, rowStyles),
            SP_REACT.createElement("h2", { style: { margin: 0 } }, title),
            children));
}
function Conversation({ me, title, chat, closeModal, changed }) {
    const { run, busy, error } = useTask();
    const [messages, setMessages] = SP_REACT.useState([]);
    const [draft, setDraft] = SP_REACT.useState("");
    const history = SP_REACT.useRef(null);
    async function refresh() {
        setMessages(await api.messages(chat.id, chat.thread));
    }
    SP_REACT.useEffect(() => { void run(refresh); }, []);
    SP_REACT.useEffect(() => {
        if (history.current)
            history.current.scrollTop = history.current.scrollHeight;
    }, [messages]);
    return SP_REACT.createElement(WideModal, { closeModal: closeModal },
        SP_REACT.createElement(DFL.Focusable, { "flow-children": "column", style: { width: "100%", minWidth: 0, boxSizing: "border-box", height: "min(510px, 70vh)", display: "flex", flexDirection: "column", gap: 8 } },
            SP_REACT.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                SP_REACT.createElement("h2", { style: { margin: 0 } }, title),
                SP_REACT.createElement(ChatIcon, { label: "Refresh conversation", disabled: busy, onClick: () => void run(refresh) }, headerIcons.Refresh)),
            SP_REACT.createElement("div", { ref: history, role: "log", "aria-label": "Conversation", tabIndex: 0, style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 6 } },
                !messages.length && SP_REACT.createElement("p", null, busy ? "Loading conversation…" : "No messages."),
                messages.map((item, index) => {
                    const mine = item.sender === me;
                    return SP_REACT.createElement("div", { key: item.id || index, style: {
                            display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", marginBottom: 8,
                        } },
                        !mine && item.name && SP_REACT.createElement("small", { style: { color: "#c3cad1" } }, item.name),
                        SP_REACT.createElement("div", { "aria-label": mine ? "You" : item.name ?? title, style: {
                                maxWidth: "85%", padding: "7px 11px", color: "#fff",
                                background: mine ? "#286c36" : "#353b42",
                                borderRadius: mine ? "13px 13px 3px 13px" : "13px 13px 13px 3px",
                                overflowWrap: "anywhere", whiteSpace: "pre-wrap",
                            } }, item.text ?? "Attachment or system message"),
                        item.date && SP_REACT.createElement("small", { style: { color: "#c3cad1" } }, new Date(item.date).toLocaleString()));
                })),
            error && SP_REACT.createElement("div", { role: "alert" }, error),
            SP_REACT.createElement(DFL.TextField, { label: "Message", value: draft, disabled: busy, inlineControls: SP_REACT.createElement(ChatIcon, { label: "Send message", disabled: busy || !draft.trim(), inline: true, onClick: () => void run(async () => {
                        await api.send(chat.id, chat.thread, draft);
                        setDraft("");
                        changed();
                        await refresh();
                    }) },
                    SP_REACT.createElement("path", { d: "m3 4 18 8-18 8 3-8-3-8Zm3 8h15" })), onChange: event => setDraft([...event.currentTarget.value].slice(0, 256).join("")) })));
}
function ChatIcon({ label, disabled, onClick, inline, children }) {
    return SP_REACT.createElement(DFL.DialogButton, { "aria-label": label, onOKActionDescription: label, disabled: disabled, onClick: onClick, style: { width: 32, minWidth: 32, height: 32, padding: 0, marginInline: inline ? 4 : undefined,
            display: "grid", placeItems: "center" } },
        SP_REACT.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
            SP_REACT.createElement("title", null, label),
            children));
}
function SearchDialog({ openChat, closeModal }) {
    const { run, busy, error } = useTask();
    const [query, setQuery] = SP_REACT.useState("");
    const [results, setResults] = SP_REACT.useState();
    return SP_REACT.createElement(Dialog, { title: "Search PlayStation Network", closeModal: closeModal },
        SP_REACT.createElement(DFL.TextField, { label: "Online ID", value: query, disabled: busy, onChange: event => setQuery(event.currentTarget.value) }),
        SP_REACT.createElement(DFL.DialogButton, { disabled: busy || !query.trim(), onClick: () => void run(async () => {
                setResults(await api.search(query.trim()));
            }) }, "Search"),
        busy && SP_REACT.createElement("div", { role: "status" }, "Searching\u2026"),
        error && SP_REACT.createElement("div", { role: "alert" }, error),
        results?.length === 0 && SP_REACT.createElement("div", null, "No players found."),
        results?.map(player => SP_REACT.createElement(PlayerRow, { key: player.id, player: player, disabled: busy, action: () => {
                closeModal?.();
                openChat(player);
            } })));
}
function InviteDialog({ party, friends, closeModal }) {
    const { run, busy, error } = useTask();
    const [sent, setSent] = SP_REACT.useState([]);
    const available = friends.filter(friend => !party.members.some(member => member.id === friend.id));
    return SP_REACT.createElement(Dialog, { title: "Invite friends", closeModal: closeModal },
        error && SP_REACT.createElement("div", { role: "alert" }, error),
        !available.length && SP_REACT.createElement("div", null, "No friends available to invite."),
        available.map(player => SP_REACT.createElement(PlayerRow, { key: player.id, player: player, detail: sent.includes(player.id) ? "Invitation sent" : undefined, disabled: busy || sent.includes(player.id), action: () => void run(async () => {
                await api.invite(party.id, player.id);
                setSent(previous => [...previous, player.id]);
            }) })));
}
function RelationshipsDialog({ closeModal }) {
    const { run, busy, error } = useTask();
    const [blocked, setBlocked] = SP_REACT.useState(false);
    const [players, setPlayers] = SP_REACT.useState();
    function load(showBlocked) {
        void run(async () => {
            setBlocked(showBlocked);
            setPlayers(undefined);
            setPlayers(await api.relationships(showBlocked));
        });
    }
    SP_REACT.useEffect(() => { load(false); }, []);
    return SP_REACT.createElement(Dialog, { title: "Friend requests and blocked players", closeModal: closeModal },
        SP_REACT.createElement(DFL.Focusable, { "flow-children": "row", style: { display: "flex", flexWrap: "wrap", gap: 4 } },
            SP_REACT.createElement(DFL.DialogButton, { disabled: busy, "aria-pressed": !blocked, onClick: () => load(false) }, "Incoming requests"),
            SP_REACT.createElement(DFL.DialogButton, { disabled: busy, "aria-pressed": blocked, onClick: () => load(true) }, "Blocked players")),
        busy && SP_REACT.createElement("div", { role: "status" }, "Loading\u2026"),
        error && SP_REACT.createElement("div", { role: "alert" }, error),
        players?.length === 0 && SP_REACT.createElement("div", null, blocked ? "No blocked players." : "No incoming requests."),
        players?.map(player => SP_REACT.createElement(PlayerRow, { key: player.id, player: player })));
}
const tabs = ["Friends", "Messages", "Parties"];
const headerIcons = {
    Friends: SP_REACT.createElement(SP_REACT.Fragment, null,
        SP_REACT.createElement("circle", { cx: "9", cy: "8", r: "3" }),
        SP_REACT.createElement("path", { d: "M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M17 5a3 3 0 0 1 0 6m4 9v-2a4 4 0 0 0-3-3.9" })),
    Messages: SP_REACT.createElement("path", { d: "M21 5H3v12h4v4l5-4h9zM7 9h10m-10 4h7" }),
    Parties: SP_REACT.createElement(SP_REACT.Fragment, null,
        SP_REACT.createElement("path", { d: "M3 14v-2a9 9 0 0 1 18 0v2m-1 5c-1 2-3 2-6 2" }),
        SP_REACT.createElement("rect", { x: "3", y: "12", width: "4", height: "7", rx: "2" }),
        SP_REACT.createElement("rect", { x: "17", y: "12", width: "4", height: "7", rx: "2" })),
    "Manage friends": SP_REACT.createElement(SP_REACT.Fragment, null,
        SP_REACT.createElement("circle", { cx: "8", cy: "7", r: "3" }),
        SP_REACT.createElement("path", { d: "M2 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m3-12h5m-5 5h5m-5 5h5" })),
    Search: SP_REACT.createElement(SP_REACT.Fragment, null,
        SP_REACT.createElement("circle", { cx: "10.5", cy: "10.5", r: "6" }),
        SP_REACT.createElement("path", { d: "m15 15 5 5" })),
    Settings: SP_REACT.createElement(SP_REACT.Fragment, null,
        SP_REACT.createElement("path", { d: "m10 3-.6 2.3-1.6.9-2.3-.6-2 3.4 1.7 1.7v1.8l-1.7 1.7 2 3.4 2.3-.6 1.6.9.6 2.3h4l.6-2.3 1.6-.9 2.3.6 2-3.4-1.7-1.7v-1.8l1.7-1.7-2-3.4-2.3.6-1.6-.9L14 3z" }),
        SP_REACT.createElement("circle", { cx: "12", cy: "11.6", r: "2.7" })),
    Refresh: SP_REACT.createElement("path", { d: "M20 9a8 8 0 0 0-14-3L3 9m0-5v5h5m-4 6a8 8 0 0 0 14 3l3-3m0 5v-5h-5" }),
};
function HeaderButton({ label, active, disabled, className, onClick }) {
    return SP_REACT.createElement(DFL.DialogButton, { className: ["psn-social-control", active && "psn-social-active", className].filter(Boolean).join(" "), "aria-pressed": active, "aria-label": label, onOKActionDescription: label, disabled: disabled, onClick: onClick },
        SP_REACT.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: "1.8", fill: "none", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
            SP_REACT.createElement("title", null, label),
            headerIcons[label]));
}
function AccountSettings({ session, connected, disconnect, voiceMode, changeVoiceMode, closeModal }) {
    const { run, busy, error } = useTask();
    const [account, setAccount] = SP_REACT.useState(session);
    const [mode, setMode] = SP_REACT.useState(voiceMode);
    const [code, setCode] = SP_REACT.useState("");
    return SP_REACT.createElement(Dialog, { title: "PlayDeck settings", closeModal },
        SP_REACT.createElement("strong", null, "Party voice connection"),
        SP_REACT.createElement(DFL.Focusable, { "flow-children": "row", style: { display: "flex", gap: 6 } },
            [["server", "Auto"], ["direct", "Direct"]].map(([value, label]) => SP_REACT.createElement(DFL.DialogButton, {
                key: value, "aria-pressed": mode === value, disabled: busy,
                style: mode === value ? { background: "#fff", color: "#0e141b" } : undefined,
                onClick: () => void run(async () => { changeVoiceMode(value); setMode(value); }),
            }, label))),
        SP_REACT.createElement("div", { className: "psn-social-player-subtitle" }, "Used when joining or connecting to party voice."),
        account ? SP_REACT.createElement(SP_REACT.Fragment, null,
            SP_REACT.createElement("div", null, `Connected as ${account.me.name}`),
            SP_REACT.createElement(DFL.DialogButton, { disabled: busy, onClick: () => void run(async () => {
                await disconnect();
                setAccount(null);
            }) }, "Disconnect PlayStation Network")) : SP_REACT.createElement(SP_REACT.Fragment, null,
            SP_REACT.createElement(DFL.DialogButton, { disabled: busy, onClick: () => window.SteamClient.System.OpenInSystemBrowser("https://ca.account.sony.com/api/v1/ssocookie") }, "Get Sony NPSSO code"),
            SP_REACT.createElement(DFL.TextField, { bIsPassword: true, label: "Sony NPSSO code", disabled: busy, value: code, onChange: event => setCode(event.currentTarget.value) }),
            SP_REACT.createElement(DFL.DialogButton, { disabled: busy || !code.trim(), onClick: () => void run(async () => {
                await api.signIn(code);
                setCode("");
                const next = await api.load();
                if (!next)
                    throw new Error("Could not load the connected PlayStation account. Try again.");
                connected(next);
                setAccount(next);
            }) }, "Connect PlayStation Network")),
        busy && SP_REACT.createElement("div", { role: "status" }, "Connecting..."),
        error && SP_REACT.createElement("div", { role: "alert" }, error));
}
function SocialPanel({ initialTab = "Friends", settingsOnOpen = false }) {
    const { run, busy, error } = useTask();
    const voice = useSharedPartyVoice();
    const [session, setSession] = SP_REACT.useState();
    const [tab, setTab] = SP_REACT.useState(initialTab);
    const settingsOpened = SP_REACT.useRef(false);
    const [inbox, setInbox] = SP_REACT.useState();
    const [parties, setParties] = SP_REACT.useState();
    const [inboxDirty, setInboxDirty] = SP_REACT.useState(false);
    SP_REACT.useEffect(() => { void run(async () => {
        setSession(await api.load());
        if (initialTab === "Parties")
            setParties(await api.parties());
    }); }, []);
    SP_REACT.useEffect(() => {
        if (settingsOnOpen && session && !settingsOpened.current) {
            settingsOpened.current = true;
            openSettings();
        }
    }, [Boolean(session)]);
    function title(chat, me) {
        return chat.name || chat.members.filter(member => member.id !== me.id).map(member => member.name).join(", ") || "Conversation";
    }
    function openChat(chat, label, me) {
        DFL.showModal(SP_REACT.createElement(Conversation, { me: me.id, title: label, chat: chat, changed: () => setInboxDirty(true) }));
    }
    function messagePlayer(player) {
        if (!session || player.id === session.me.id)
            return;
        void run(async () => {
            const chats = await api.inbox();
            const existing = chats.find(chat => chat.members.length === 2 &&
                chat.members.some(member => member.id === player.id) && chat.members.some(member => member.id === session.me.id));
            openChat(existing ?? await api.createChat(player.id), player.name, session.me);
        });
    }
    async function loadTab(next) {
        if (next === "Friends")
            setSession(await api.load());
        if (next === "Messages") {
            setInbox(await api.inbox());
            setInboxDirty(false);
        }
        if (next === "Parties")
            setParties(await api.parties());
    }
    function partyAction(action, success, connectVoice = false) {
        void run(async () => {
            const sessionId = await action();
            try {
                await loadTab("Parties");
                if (connectVoice)
                    void voice.start(sessionId, readVoiceConnectionMode());
            }
            catch (error) {
                setParties(undefined);
                throw new Error(`${success} The party list could not refresh. ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }
    function openSettings() {
        DFL.showModal(SP_REACT.createElement(AccountSettings, { session, connected: setSession, voiceMode: readVoiceConnectionMode(), changeVoiceMode: mode => {
            localStorage.setItem("PLAYDECK_VOICE_CONNECTION", mode);
        }, disconnect: async () => {
            await voice.stop();
            await api.signOut();
            setSession(null);
            setInbox(undefined);
            setParties(undefined);
            setTab("Friends");
        } }));
    }
    return SP_REACT.createElement(SP_REACT.Fragment, null,
        SP_REACT.createElement("style", null, rowStyles),
        !session && SP_REACT.createElement("header", { className: "psn-social-header" },
            SP_REACT.createElement("strong", null, "PlayStation Network"),
            SP_REACT.createElement("div", { className: "psn-social-header-status", role: "status" }, busy ? "Connecting..." : "Connect your PlayStation account in settings."),
            SP_REACT.createElement(DFL.Focusable, { className: "psn-social-nav", "flow-children": "row" },
                SP_REACT.createElement(HeaderButton, { label: "Refresh", className: "psn-social-action-start", disabled: busy, onClick: () => void run(async () => setSession(await api.load())) }),
                SP_REACT.createElement(HeaderButton, { label: "Settings", onClick: openSettings })),
            error && SP_REACT.createElement("div", { className: "psn-social-header-alert", role: "alert" }, error)),
        session && SP_REACT.createElement(SP_REACT.Fragment, null,
            SP_REACT.createElement("header", { className: "psn-social-header" },
                SP_REACT.createElement("div", { className: "psn-social-profile" },
                    SP_REACT.createElement(ProfileAvatar, { player: { ...session.me, muted: Boolean(voice.activeParty) && voice.muted } }),
                    SP_REACT.createElement("div", { className: "psn-social-profile-copy" },
                        SP_REACT.createElement("strong", null, session.me.name),
                        SP_REACT.createElement("div", { className: "psn-social-profile-meta" },
                            SP_REACT.createElement("span", null,
                                SP_REACT.createElement("span", { className: "psn-social-profile-dot", style: { background: presenceTone(session.me) } }),
                                playerPresence(session.me)),
                            session.me.level != null && SP_REACT.createElement("span", { className: "psn-social-trophy", "aria-label": `Trophy level ${session.me.level}` },
                                SP_REACT.createElement("svg", { viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true" },
                                    SP_REACT.createElement("path", { d: "M8 3h8v5a4 4 0 0 1-8 0V3Zm0 2H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4m-4 1v7m-4 0h8" })),
                                session.me.level)))),
                SP_REACT.createElement(DFL.Focusable, { className: "psn-social-nav", "flow-children": "row" },
                    tabs.map(next => SP_REACT.createElement(HeaderButton, { key: next, label: next, active: tab === next, disabled: busy, onClick: () => {
                            setTab(next);
                            if ((next === "Messages" && (!inbox || inboxDirty)) || next === "Parties")
                                void run(() => loadTab(next));
                        } })),
                    SP_REACT.createElement(HeaderButton, { label: "Manage friends", className: "psn-social-action-start", disabled: busy, onClick: () => DFL.showModal(SP_REACT.createElement(RelationshipsDialog, null)) }),
                    SP_REACT.createElement(HeaderButton, { label: "Search", disabled: busy, onClick: () => DFL.showModal(SP_REACT.createElement(SearchDialog, { openChat: messagePlayer })) }),
                    SP_REACT.createElement(HeaderButton, { label: "Refresh", disabled: busy, onClick: () => void run(() => loadTab(tab)) }),
                    SP_REACT.createElement(HeaderButton, { label: "Settings", onClick: openSettings })),
                error && tab !== "Parties" && SP_REACT.createElement("div", { className: "psn-social-header-alert", role: "alert" }, error),
                busy && SP_REACT.createElement("div", { className: "psn-social-header-status", role: "status" }, "Working\u2026")),
            tab === "Friends" && SP_REACT.createElement(DFL.PanelSection, null,
                SP_REACT.createElement("section", { className: "psn-social-list" },
                    SP_REACT.createElement("h2", null, "Friends"),
                    ["Online", "Offline", "Unknown"].map(group => {
                        const players = session.friends.filter(player => {
                            const presence = playerPresence(player);
                            return presence === group || (group === "Online" && presence === "Away");
                        }).sort((a, b) => a.name.localeCompare(b.name));
                        if (!players.length && group !== "Online")
                            return null;
                        return SP_REACT.createElement("section", { key: group, className: "psn-social-group", "aria-label": group },
                            SP_REACT.createElement("h3", null,
                                group,
                                " ",
                                SP_REACT.createElement("span", null, players.length)),
                            !players.length && SP_REACT.createElement("div", null, "No friends online."),
                            players.map(player => SP_REACT.createElement(PlayerRow, { key: player.id, player: player, disabled: busy, action: () => messagePlayer(player) })));
                    }))),
            tab === "Messages" && SP_REACT.createElement(DFL.PanelSection, null,
                SP_REACT.createElement(DFL.PanelSectionRow, null,
                    SP_REACT.createElement("h2", { style: { fontSize: 14, margin: 0, textTransform: "none" } }, "Messages")),
                inbox?.length === 0 && SP_REACT.createElement(DFL.PanelSectionRow, null, "No conversations."),
                SP_REACT.createElement("div", { className: "psn-social-list psn-social-group" }, inbox?.map(chat => {
                    const peer = chat.members.find(member => member.id !== session.me.id);
                    const name = title(chat, session.me);
                    const friend = session.friends.find(player => player.id === peer?.id);
                    const preview = chat.latest?.text ?? (chat.latest ? "Attachment or system message" : "No messages");
                    return SP_REACT.createElement(PlayerRow, { key: chat.id, player: { id: chat.id, name, avatar: peer?.avatar ?? friend?.avatar, avatars: [...(peer?.avatars ?? []), ...(friend?.avatars ?? [])] }, detail: chat.unread ? `● ${preview}` : preview, disabled: busy, action: () => openChat(chat, name, session.me) });
                }))),
            tab === "Parties" && SP_REACT.createElement(DFL.PanelSection, null,
                !parties?.length && SP_REACT.createElement(DFL.PanelSectionRow, null,
                    SP_REACT.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                        SP_REACT.createElement("h2", { style: { fontSize: 14, margin: 0 } }, "Party"),
                        !voice.activeParty && SP_REACT.createElement(PartyCreateButtons, { disabled: busy || voice.stopping,
                            create: friends => partyAction(() => api.createParty(friends), "Party created.", true) }))),
                error && SP_REACT.createElement(DFL.PanelSectionRow, null,
                    SP_REACT.createElement("div", { className: "psn-social-header-alert", role: "alert" }, error)),
                parties?.length === 0 && SP_REACT.createElement(DFL.PanelSectionRow, null, "No parties or invitations."),
                parties?.map((party, partyIndex) => {
                    const member = party.members.some(player => player.id === session.me.id);
                    const joinButton = !member && SP_REACT.createElement(PartyRowButton, { label: party.invited ? "Accept invitation" : "Join party",
                        disabled: busy || voice.stopping || Boolean(voice.activeParty),
                        onClick: () => partyAction(async () => { await api.join(party.id); return party.id; }, "Party joined.", true) },
                        SP_REACT.createElement("path", { d: "M14 4h6v16h-6M3 12h12m-4-4 4 4-4 4" }));
                    return SP_REACT.createElement(DFL.PanelSectionRow, { key: party.id },
                        SP_REACT.createElement(DFL.Focusable, { "flow-children": "column", style: { display: "grid", gap: 4 } },
                            SP_REACT.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                                SP_REACT.createElement("h2", { style: { fontSize: 14, margin: 0 } }, party.name || "Party"),
                                member ? SP_REACT.createElement(DFL.Focusable, { "flow-children": "row", style: { display: "flex", gap: 4 } },
                                    SP_REACT.createElement(PartyRowButton, { label: voice.activeParty === party.id ? "Disconnect voice" : "Connect voice",
                                        disabled: busy || voice.stopping || Boolean(voice.activeParty && voice.activeParty !== party.id),
                                        onClick: () => voice.activeParty === party.id ? void voice.stop() : void voice.start(party.id, readVoiceConnectionMode()) },
                                        SP_REACT.createElement("path", { d: "M3 14v-2a9 9 0 0118 0v2m-1 5c-1 2-3 2-6 2" }),
                                        SP_REACT.createElement("rect", { x: 3, y: 12, width: 4, height: 7, rx: 2 }),
                                        SP_REACT.createElement("rect", { x: 17, y: 12, width: 4, height: 7, rx: 2 }),
                                        voice.activeParty === party.id && SP_REACT.createElement("path", { d: "m3 3 18 18" })),
                                    voice.activeParty === party.id && voice.status?.connected && SP_REACT.createElement(PartyRowButton, {
                                        label: voice.muted ? "Unmute microphone" : "Mute microphone", disabled: busy, onClick: voice.toggleMute },
                                        SP_REACT.createElement("rect", { x: 9, y: 3, width: 6, height: 12, rx: 3 }),
                                        SP_REACT.createElement("path", { d: "M5 11a7 7 0 0014 0m-7 7v3m-3 0h6" }),
                                        voice.muted && SP_REACT.createElement("path", { d: "m3 3 18 18" })),
                                    SP_REACT.createElement(PartyRowButton, { label: "Invite friends", disabled: busy,
                                        onClick: () => DFL.showModal(SP_REACT.createElement(InviteDialog, { party, friends: session.friends })) },
                                        SP_REACT.createElement("circle", { cx: 8, cy: 7, r: 3 }),
                                        SP_REACT.createElement("path", { d: "M2 20v-2a4 4 0 014-4h4a4 4 0 014 4v2m4-13v8m-4-4h8" })),
                                    SP_REACT.createElement(PartyRowButton, { label: "Leave party", disabled: busy || voice.stopping,
                                        onClick: () => partyAction(async () => {
                                            if (voice.activeParty === party.id) await voice.stop();
                                            await api.leave(party.id);
                                        }, "Party left.") },
                                        SP_REACT.createElement("path", { d: "M10 4H4v16h6m-1-8h12m-4-4 4 4-4 4" }))) :
                                    SP_REACT.createElement(DFL.Focusable, { "flow-children": "row", style: { display: "flex", gap: 6 } },
                                        partyIndex === 0 && !voice.activeParty && !parties.some(room => room.members.some(player => player.id === session.me.id)) &&
                                            SP_REACT.createElement(PartyCreateButtons, { disabled: busy || voice.stopping,
                                                create: friends => partyAction(() => api.createParty(friends), "Party created.", true) }),
                                        !party.members.length && joinButton)),
                            party.members.map((player, index) => SP_REACT.createElement(PartyMemberRow, { key: player.id, action: index === 0 ? joinButton : undefined,
                                player: partyMemberPresentation(player, [session.me, ...session.friends].find(friend => friend.id === player.id), {
                                    self: player.id === session.me.id, active: voice.activeParty === party.id,
                                    connected: voice.status?.party === party.id && voice.status.connected,
                                    failed: voice.status?.party === party.id && voice.status.error,
                                    peerStates: voice.peerStates, muted: voice.muted, startedAt: voice.startedAt,
                                }) })),
                            voice.activeParty === party.id && voice.muteError && SP_REACT.createElement("div", { role: "alert" }, voice.muteError)));
                }))));
}
const pluginIcon = SP_REACT.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        SP_REACT.createElement("rect", { x: "1", y: "5", width: "22", height: "14", rx: "4" }),
        SP_REACT.createElement("rect", { x: "8", y: "8", width: "8", height: "8", rx: "1" }),
        SP_REACT.createElement("path", { d: "M3.5 10h2.5m-1.25-1.25v2.5" }),
        SP_REACT.createElement("rect", { x: "3.5", y: "13.5", width: "2.5", height: "2.5", rx: ".5" }),
        SP_REACT.createElement("path", { d: "m19.5 8 1.35 2.4h-2.7L19.5 8Z", strokeWidth: "1" }),
        SP_REACT.createElement("circle", { cx: "20.5", cy: "13", r: "1", strokeWidth: "1" }),
        SP_REACT.createElement("path", { d: "m18.15 15.05 1.7 1.7m0-1.7-1.7 1.7", strokeWidth: "1" }));
var index = definePlugin(() => {
    const routerHook = api$1.routerHook;
    const partyRoute = "/playdeck/party";
    const menuRoute = "/playdeck";
    const settingsRoute = "/playdeck/settings";
    function openRoute(route) {
        DFL.Navigation.Navigate(route);
        DFL.Navigation.CloseSideMenus();
    }
    partyBadge = installPartyBadge(routerHook, () => openRoute(partyRoute));
    routerHook.addGlobalComponent("playdeck-voice", PartyVoiceHost);
    function routePanel(props) {
        return SP_REACT.createElement(DFL.Focusable, { "flow-children": "column", style: {
            position: "absolute", inset: "56px 0 48px", overflowY: "auto", boxSizing: "border-box",
            padding: "12px 24px 24px", scrollPadding: "12px 0 24px",
        }, onFocus: event => {
            if (event.currentTarget !== event.target)
                event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
        } }, SP_REACT.createElement(SocialPanel, props));
    }
    routerHook.addRoute(partyRoute, () => routePanel({ initialTab: "Parties" }), { exact: true });
    routerHook.addRoute(menuRoute, () => routePanel({}), { exact: true });
    routerHook.addRoute(settingsRoute, () => routePanel({ settingsOnOpen: true }), { exact: true });
    let menuPosition = 3;
    try {
        const saved = Number(localStorage.getItem("PLAYDECK_MENU_POSITION") ?? 3);
        if (Number.isInteger(saved) && saved >= 1 && saved <= 9)
            menuPosition = saved;
    } catch { /* Keep the default position if storage is unavailable. */ }
    function chooseMenuPosition() {
        const dropdown = new DFL.Dropdown({
            rgOptions: Array.from({ length: 9 }, (_, index) => ({ data: index + 1, label: String(index + 1) })),
            selectedOption: menuPosition,
            onChange: ({ data }) => {
                try {
                    localStorage.setItem("PLAYDECK_MENU_POSITION", String(data));
                    menuPosition = data;
                } catch {
                    api$1.toaster.toast({ title: "PlayDeck", body: "Could not save Steam menu position." });
                }
            },
        });
        dropdown.ShowMenu();
    }
    const removeMenu = installSteamMainMenuEntry(menuRoute, pluginIcon, () => menuPosition,
        chooseMenuPosition, () => openRoute(settingsRoute));
    return {
        name: "PlayDeck",
        titleView: SP_REACT.createElement("div", { className: DFL.staticClasses.Title }, "PlayDeck"),
        content: SP_REACT.createElement(SocialPanel, null),
        icon: pluginIcon,
        onDismount() {
            void voiceSnapshot.stop();
            removeMenu();
            partyBadge.remove();
            partyBadge = undefined;
            routerHook.removeGlobalComponent("playdeck-voice");
            routerHook.removeRoute(partyRoute);
            routerHook.removeRoute(menuRoute);
            routerHook.removeRoute(settingsRoute);
            voiceListeners.clear();
        },
    };
});

export { index as default };
