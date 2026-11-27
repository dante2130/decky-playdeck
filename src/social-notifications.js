import { t } from "./i18n.js";

function notificationName(id, fallback, ...profiles) {
    for (const profile of profiles)
        if (profile?.fullName?.trim())
            return profile.fullName.trim();
    for (const profile of profiles)
        if (profile?.name && profile.name !== id)
            return profile.name;
    return fallback;
}

export function pendingPartyInvites(parties, account) {
    return parties.filter(party => party.invited && !party.members.some(member => member.id === account.me.id))
        .map(party => {
            const inviter = party.inviter;
            const name = inviter && notificationName(inviter.id, "", inviter,
                account.friends.find(friend => friend.id === inviter.id));
            return {
                id: party.invitationId || party.id,
                body: name ? t("{name} invited you to a PlayDeck party", { name }) : party.name ?
                    t("You were invited to {party}", { party: party.name }) : t("You received a PlayStation party invite"),
            };
        });
}

export function partyNotifications(previous, next, account) {
    const notices = [];
    const oldParties = new Map(previous.map(party => [party.id, party]));
    const hasMe = party => party?.members.some(member => member.id === account.me.id);
    const newParties = new Map(next.map(party => [party.id, party]));
    for (const party of previous)
        if (hasMe(party) && !hasMe(newParties.get(party.id)))
            notices.push(t("You left the party"));
    for (const party of next) {
        const old = oldParties.get(party.id);
        if (hasMe(party) && !hasMe(old))
            notices.push(t("You joined the party"));
        if (!hasMe(party) || !hasMe(old))
            continue;
        const oldMembers = new Map(old.members.map(member => [member.id, member]));
        const members = new Map(party.members.map(member => [member.id, member]));
        const name = member => notificationName(member.id, t("A player"), member,
            account.friends.find(friend => friend.id === member.id));
        for (const member of members.values())
            if (!oldMembers.has(member.id))
                notices.push(t("{name} joined the party", { name: name(member) }));
        for (const member of oldMembers.values())
            if (!members.has(member.id))
                notices.push(t("{name} left the party", { name: name(member) }));
    }
    return notices;
}

export function incomingMessages(chat, previous, history, account, since) {
    const latest = chat.latest;
    if (!latest?.id || latest.id === previous?.id)
        return [];
    const knownIndex = history.findIndex(message => message.id === previous?.id);
    const cutoff = previous?.date ? Date.parse(previous.date) : since;
    const newer = knownIndex >= 0 ? history.slice(knownIndex + 1) :
        history.filter(message => Date.parse(message.date) > cutoff);
    const latestIsNew = knownIndex >= 0 ? newer.some(message => message.id === latest.id) || !history.some(message => message.id === latest.id) :
        !latest.date || !Number.isFinite(cutoff) || Date.parse(latest.date) >= cutoff;
    const messages = new Map(newer.map(message => [message.id, message]));
    if (latestIsNew && !messages.has(latest.id))
        messages.set(latest.id, latest);
    return [...messages.values()].filter(message => message.id && message.sender && message.sender !== account.me.id)
        .map(message => {
            const name = notificationName(message.sender, t("A PlayStation player"), message,
                chat.members.find(member => member.id === message.sender),
                account.friends.find(friend => friend.id === message.sender));
            const preview = (message.text || t(message.attachments?.[0]?.label ?? "")).replace(/\s+/g, " ").trim();
            return preview ? `${name}: ${preview.length > 120 ? preview.slice(0, 117) + "…" : preview}` : t("{name} sent a message", { name });
        });
}
