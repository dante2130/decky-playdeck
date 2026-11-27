import test from 'node:test';
import assert from 'node:assert/strict';
import { incomingMessages, partyNotifications, pendingPartyInvites } from '../src/social-notifications.js';

const me = { id: '1', name: 'Me' };
const guest = { id: '2', name: 'Guest' };
const friend = { id: '3', name: 'Friend' };
const account = { me, friends: [friend] };

test('new invitations and live roster changes are announced once with nicknames', () => {
    const previous = [{ id: 'active', members: [me, guest] }];
    const next = [
        { id: 'active', members: [me, { id: friend.id, name: friend.id }] },
        { id: 'invite', name: 'Friday', invited: true, members: [guest] },
        { id: 'other', members: [guest] },
    ];
    assert.deepEqual(partyNotifications(previous, next, account),
        ['Friend joined the party', 'Guest left the party']);
    assert.deepEqual(pendingPartyInvites(next, account), [{ id: 'invite', body: 'You were invited to Friday' }]);
    assert.deepEqual(partyNotifications(next, next, account), []);
    assert.deepEqual(partyNotifications(previous, [{ id: 'active', members: [guest] }], account), ['You left the party']);
    assert.deepEqual(partyNotifications([], previous, account), ['You joined the party']);
});

test('a pending invite carries its own identity and uses the sender’s real name', () => {
    const invite = { id: 'party', invitationId: 'invitation', invited: true, inviter: guest, members: [] };
    const directory = { ...account, friends: [{ ...guest, fullName: 'Alex Example' }] };
    assert.deepEqual(pendingPartyInvites([invite], directory), [
        { id: 'invitation', body: 'Alex Example invited you to a PlayDeck party' },
    ]);
    assert.deepEqual(pendingPartyInvites([{ ...invite, members: [me] }], directory), []);
});

test('incoming messages include bursts, skip your messages and use sender nicknames', () => {
    const old = { id: 'old', sender: guest.id, date: '2026-11-27T10:00:00Z' };
    const received = { id: 'new', sender: guest.id, text: 'Hello', date: '2026-11-27T10:00:01Z' };
    const sent = { id: 'self', sender: me.id, text: 'Hi', date: '2026-11-27T10:00:02Z' };
    const chat = { members: [me, guest], latest: sent };
    assert.deepEqual(incomingMessages(chat, old, [old, received, sent], account, 0), ['Guest: Hello']);
    assert.deepEqual(incomingMessages(chat, sent, [old, received, sent], account, 0), []);
    assert.deepEqual(incomingMessages({ ...chat, latest: old }, sent, [old, received], account, 0), []);
    assert.deepEqual(incomingMessages({ ...chat, latest: old }, undefined, [old], account, Date.parse(sent.date)), []);
    assert.deepEqual(incomingMessages({ ...chat, latest: received }, old, [], account, 0), ['Guest: Hello']);
});

test('party and message notifications prefer an available real name', () => {
    const namedGuest = { ...guest, fullName: 'Alex Example' };
    const directory = { ...account, friends: [namedGuest] };
    const previous = [{ id: 'active', members: [me] }];
    const next = [{ id: 'active', members: [me, guest] }];
    assert.deepEqual(partyNotifications(previous, next, directory), ['Alex Example joined the party']);
    assert.deepEqual(partyNotifications(next, previous, directory), ['Alex Example left the party']);
    const latest = { id: 'new', sender: guest.id, name: guest.name, text: 'Hi' };
    assert.deepEqual(incomingMessages({ members: [me, namedGuest], latest }, undefined, [], account, 0), ['Alex Example: Hi']);
});
