import test from 'node:test';
import assert from 'node:assert/strict';
import { partyMemberPresentation, bridgePeerState } from '../src/party-presentation.js';
const player = { id: '42', name: 'Player' };
const profile = { status: 'online', avatar: 'avatar.png', game: 'Game' };

test('bridge connection alone does not mark a remote player connected', () => {
    const result = partyMemberPresentation(player, profile, { active: true, connected: true });
    assert.equal(result.detail, 'Connecting...');
    assert.equal(result.voiceError, false);
});
test('connected player uses real online presence and game', () => {
    const result = partyMemberPresentation(player, profile, { active: true, peerStates: { 42: { state: 'connected' } } });
    assert.equal(result.detail, undefined);
    assert.equal(result.status, 'online');
    assert.equal(result.game, 'Game');
});
test('peer failure is isolated to that player', () => {
    const peerStates = { 42: { state: 'failed' }, 43: { state: 'connected' } };
    assert.equal(partyMemberPresentation(player, profile, { active: true, peerStates }).voiceError, true);
    assert.equal(partyMemberPresentation({ ...player, id: '43' }, profile, { active: true, peerStates }).voiceError, false);
});
test('mute and connection error are independent avatar indicators', () => {
    const muted = partyMemberPresentation(player, profile, { self: true, active: true, connected: true, muted: true });
    assert.equal(muted.muted, true);
    assert.equal(muted.voiceError, false);
    const failed = partyMemberPresentation(player, profile, { failed: true });
    assert.equal(failed.voiceError, true);
    assert.equal(failed.detail, 'Connection error');
});
test('idle players do not retain stale connection errors', () => {
    assert.equal(partyMemberPresentation(player, profile, { peerStates: { 42: { state: 'failed' } } }).voiceError, false);
});
test('unidentified peer times out instead of connecting forever', () => {
    assert.equal(partyMemberPresentation(player, profile, { active: true, startedAt: 1000, now: 31001 }).voiceError, true);
});
test('peer needs handshake, announcement and audio subscription', () => {
    const entry = { channel: { readyState: 'open' }, ready: true, announced: true };
    assert.equal(bridgePeerState(entry, 'pending', 2000, 1000), 'connecting');
    assert.equal(bridgePeerState(entry, 'accepted', 2000, 1000), 'connected');
    entry.channel.readyState = 'closed';
    assert.equal(bridgePeerState(entry, 'accepted', 2000, 1000), 'failed');
    entry.channel.readyState = 'open';
    assert.equal(bridgePeerState(entry, 'accepted', 40000, 1000), 'connected');
    assert.equal(bridgePeerState(undefined, 'pending', 40000, 1000), 'failed');
});

test('voice connection mode defaults to Auto and restores Direct', async () => {
    const { readVoiceConnectionMode } = await import('../src/party-presentation.js');
    assert.equal(readVoiceConnectionMode({ getItem: () => null }), 'server');
    assert.equal(readVoiceConnectionMode({ getItem: () => 'direct' }), 'direct');
    assert.equal(readVoiceConnectionMode({ getItem: () => 'invalid' }), 'server');
    assert.equal(readVoiceConnectionMode({ getItem() { throw Error('unavailable'); } }), 'server');
});

test('remote mute badge follows fresh voice metadata in both directions', () => {
    const remote = { ...player, muted: false };
    assert.equal(partyMemberPresentation(remote, profile, { active: true, peerStates: { 42: { state: 'connected', muted: true } } }).muted, true);
    remote.muted = true;
    assert.equal(partyMemberPresentation(remote, profile, { active: true, peerStates: { 42: { state: 'connected', muted: false } } }).muted, false);
});
test('party browser uses member mute metadata before connecting voice', () => {
    assert.equal(partyMemberPresentation({ ...player, muted: true }, profile, {}).muted, true);
    assert.equal(partyMemberPresentation(player, profile, {}).muted, false);
});
