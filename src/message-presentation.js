export function formatMessageDate(value) {
    if (value === null || value === undefined || value === "")
        return "";
    if (typeof value !== "string" && typeof value !== "number")
        return "";
    const input = typeof value === "string" ? value.trim() : value;
    if (input === "")
        return "";
    // Sony sends Unix milliseconds as a string, which Date otherwise treats as calendar text.
    const timestamp = typeof input === "string" && /^-?\d+(?:\.\d+)?$/.test(input) ? Number(input) : input;
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}

export function messageParticipant(member, profiles) {
    const profile = profiles.find(player => player.id === member.id);
    return { ...member, avatar: profile?.avatar ?? member.avatar,
        avatars: [...new Set([profile?.avatar, ...(profile?.avatars ?? []), member.avatar, ...(member.avatars ?? [])].filter(Boolean))],
        status: member.status ?? profile?.status, game: member.game ?? profile?.game };
}

export function messageListPlayer(chat, me, friends, name) {
    const peers = chat.members.filter(member => member.id !== me).map(member => messageParticipant(member, friends));
    const peer = peers[0];
    return {
        id: chat.id, name, avatar: peer?.avatar, avatars: peer?.avatars ?? [],
        avatarPlayers: peers.length > 1 ? peers : undefined,
        status: peers.length === 1 ? peer.status : undefined,
        game: peers.length === 1 ? peer.game : undefined,
        hidePresence: peers.length !== 1,
    };
}

export function scrollConversationHistory(element, event) {
    if (!element)
        return false;
    if (event.target && event.target !== element && element.contains?.(event.target))
        return false;
    const button = event.detail?.button ?? ({ ArrowUp: 9, ArrowDown: 10 })[event.key];
    if (button !== 9 && button !== 10)
        return false;
    const limit = Math.max(0, element.scrollHeight - element.clientHeight);
    const top = Math.max(0, Math.min(limit, element.scrollTop));
    if ((button === 9 && top <= 1) || (button === 10 && top >= limit - 1))
        return false;
    const step = Math.max(48, element.clientHeight * 0.65);
    const next = Math.max(0, Math.min(limit, top + (button === 9 ? -step : step)));
    element.scrollTop = next;
    event.preventDefault();
    event.stopPropagation();
    return true;
}

export async function createConversationParty(api, members, me, onCreated) {
    const accounts = [...new Set(members.map(member => member.id).filter(id => id && id !== me))];
    if (!accounts.length)
        throw new Error("No other group members are available to invite.");
    if (accounts.length > 15)
        throw new Error("A party supports up to 16 players. Create a party and choose members to invite.");
    const party = await api.createParty(false);
    onCreated(party);
    const invitations = await Promise.allSettled(accounts.map(async account => api.invite(party, account)));
    return { party, failedInvites: invitations.filter(result => result.status === "rejected").length };
}
