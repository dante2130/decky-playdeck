export function partyMemberPresentation(player, profile, { self, active, connected, failed, peerStates, muted, startedAt, now = Date.now() }) {
    const merged = { ...player, avatar: player.avatar ?? profile?.avatar,
        status: player.status ?? profile?.status, game: player.game ?? profile?.game };
    const peer = peerStates?.[player.id];
    const state = failed ? "failed" : !active ? "idle" : self
        ? connected ? "connected" : "connecting" : peer?.state ?? (startedAt && now - startedAt >= 30000 ? "failed" : "connecting");
    return { ...merged, self, voiceError: state === "failed", muted: self ? active && muted : peer?.muted === true,
        voiceState: state, detail: state === "connecting" ? "Connecting..." : state === "failed" ? "Connection error" : undefined };
}

export function bridgePeerState(entry, subscription, now, firstSeen) {
    if (entry?.channel.readyState === "open" && entry.ready && entry.announced && subscription === "accepted")
        return "connected";
    if (subscription === "peer-mismatch" || subscription === "no-reply" ||
        (entry?.ready && ["closed", "closing"].includes(entry.channel.readyState)) || now - firstSeen >= 30000)
        return "failed";
    return "connecting";
}

export function readVoiceConnectionMode(storage) {
    try {
        return (storage ?? globalThis.localStorage).getItem("PLAYDECK_VOICE_CONNECTION") === "direct" ? "direct" : "server";
    } catch {
        return "server";
    }
}
