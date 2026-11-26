import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessageDate, messageListPlayer } from '../src/message-presentation.js';

test('Sony string milliseconds display the same date as numeric milliseconds', () => {
    assert.equal(formatMessageDate('1793379678000'), new Date(1793379678000).toLocaleString());
    assert.equal(formatMessageDate(1793379678000), formatMessageDate('1793379678000'));
    assert.equal(formatMessageDate(' 1793379678000 '), formatMessageDate(1793379678000));
});
test('ISO dates work and missing or invalid dates do not display Invalid Date', () => {
    assert.equal(formatMessageDate('2026-11-27T00:00:00Z'), new Date('2026-11-27T00:00:00Z').toLocaleString());
    for (const value of [undefined, null, '', ' ', 'invalid', Infinity, {}, '999999999999999999999'])
        assert.equal(formatMessageDate(value), '');
});
test('direct messages prefer Friends profile image and current participant presence', () => {
    const chat = { id: 'thread', members: [{ id: 'me' }, { id: 'other', avatar: 'photo', status: 'online' }] };
    const result = messageListPlayer(chat, 'me', [{ id: 'other', avatar: 'old', status: 'offline' }], 'Other');
    assert.equal(result.avatar, 'old');
    assert.equal(result.status, 'online');
    assert.equal(result.hidePresence, false);
});
test('missing participant details fall back to that friend’s avatar and status', () => {
    const result = messageListPlayer({ id: 'thread', members: [{ id: 'other' }] }, 'me', [{ id: 'other', avatar: 'photo', status: 'away' }], 'Other');
    assert.equal(result.avatar, 'photo');
    assert.equal(result.status, 'away');
});
test('group and empty conversations do not show an individual’s presence badge', () => {
    for (const members of [[], [{ id: 'a', status: 'online' }, { id: 'b', status: 'offline' }]]) {
        const result = messageListPlayer({ id: 'thread', members }, 'me', [], 'Group');
        assert.equal(result.hidePresence, true);
        assert.equal(result.status, undefined);
    }
});

test('controller scroll consumes up/down only while history can move', async () => {
    const { scrollConversationHistory } = await import('../src/message-presentation.js');
    const element = { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 };
    function event(button) { return { detail: { button, is_repeat: true }, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; }
    const up = event(9);
    assert.equal(scrollConversationHistory(element, up), true);
    assert.equal(element.scrollTop, 370);
    assert.equal(up.prevented && up.stopped, true);
    const down = event(10);
    assert.equal(scrollConversationHistory(element, down), true);
    assert.equal(element.scrollTop, 500);
    element.scrollTop = 800;
    const bottom = event(10);
    assert.equal(scrollConversationHistory(element, bottom), false);
    assert.equal(bottom.stopped, false);
    element.scrollTop = 0;
    assert.equal(scrollConversationHistory(element, event(9)), false);
    assert.equal(scrollConversationHistory(element, event(2)), false);
});
test('group party invites each other member once and retains partial invitation failures', async () => {
    const { createConversationParty } = await import('../src/message-presentation.js');
    const invited = [];
    let created;
    const api = { async createParty(friendsOnly) { assert.equal(friendsOnly, false); return 'party'; },
        async invite(party, account) { assert.equal(party, 'party'); invited.push(account); if (account === 'b') throw Error('offline'); } };
    const result = await createConversationParty(api, [{ id: 'me' }, { id: 'a' }, { id: 'a' }, { id: 'b' }], 'me', party => { created = party; });
    assert.deepEqual(invited, ['a', 'b']);
    assert.equal(created, 'party');
    assert.deepEqual(result, { party: 'party', failedInvites: 1 });
});
test('empty or oversized groups fail before creating a party or sending invitations', async () => {
    const { createConversationParty } = await import('../src/message-presentation.js');
    const api = { createParty() { assert.fail('must not create'); }, invite() { assert.fail('must not invite'); } };
    await assert.rejects(createConversationParty(api, [{ id: 'me' }], 'me', () => {}), /No other group members/);
    await assert.rejects(createConversationParty(api, Array.from({ length: 16 }, (_, i) => ({ id: String(i) })), 'me', () => {}), /16 players/);
});

test('group list avatars include other participants and keep individual profile fallbacks', () => {
    const chat = { id: 'group', members: [{ id: 'me', avatar: 'self' }, { id: 'a', name: 'A', avatar: 'a-photo' }, { id: 'b', name: 'B' }] };
    const result = messageListPlayer(chat, 'me', [{ id: 'b', avatar: 'b-photo' }], 'Group');
    assert.deepEqual(result.avatarPlayers.map(player => player.avatar), ['a-photo', 'b-photo']);
    assert.equal(result.hidePresence, true);
});

test('history does not consume directions from attachment buttons', async () => {
    const { scrollConversationHistory } = await import('../src/message-presentation.js');
    const target = {};
    const element = { scrollTop: 100, scrollHeight: 1000, clientHeight: 200, contains: value => value === target };
    const event = { target, detail: { button: 10 }, preventDefault() { assert.fail('must allow attachment navigation'); }, stopPropagation() { assert.fail('must bubble'); } };
    assert.equal(scrollConversationHistory(element, event), false);
    assert.equal(element.scrollTop, 100);
});


test('group and sender rows use the same preferred Friends profile image', async () => {
    const { messageParticipant } = await import('../src/message-presentation.js');
    const profile = { id: 'friend', avatar: 'personal-photo', avatars: ['personal-photo', 'psn-avatar'] };
    const member = { id: 'friend', avatar: 'messaging-avatar', status: 'online' };
    assert.equal(messageParticipant(member, [profile]).avatar, profile.avatar);
    assert.equal(messageListPlayer({ id: 'group', members: [member, { id: 'other' }] }, 'me', [profile], 'Group').avatarPlayers[0].avatar, profile.avatar);
});
