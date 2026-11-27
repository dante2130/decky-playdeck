export function partyMemberPresentation(player, profile, { self, active, connected, failed, peerStates, muted, speaking, startedAt, now = Date.now() }) {
    const merged = { ...player, avatar: player.avatar ?? profile?.avatar,
        name: player.fullName?.trim() || profile?.fullName?.trim() || player.name,
        status: player.status ?? profile?.status, game: player.game ?? profile?.game };
    const peer = peerStates?.[player.id];
    const state = failed ? "failed" : !active ? "idle" : self
        ? connected ? "connected" : "connecting" : peer?.state ?? (startedAt && now - startedAt >= 30000 ? "failed" : "connecting");
    const isMuted = Boolean(active && (self ? muted : typeof peer?.muted === "boolean" ? peer.muted : player.muted === true));
    // Remote mute metadata can lag behind audio already arriving from that account.
    const isSpeaking = Boolean(active && connected && !failed &&
        (self ? !isMuted && speaking?.includes("self") : speaking?.includes(player.id)));
    return { ...merged, self, voiceError: state === "failed", muted: isMuted && !isSpeaking,
        speaking: isSpeaking,
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

export function partySpeakingMembers(speaking, members, selfId) {
    if (!speaking?.includes("bridge"))
        return speaking;
    const remote = members.filter(member => member.id !== selfId);
    return remote.length === 1 ? [...speaking, remote[0].id] : speaking;
}

export function readVoiceConnectionMode(storage) {
    try {
        return (storage ?? globalThis.localStorage).getItem("PLAYDECK_VOICE_CONNECTION") === "direct" ? "direct" : "server";
    } catch {
        return "server";
    }
}
