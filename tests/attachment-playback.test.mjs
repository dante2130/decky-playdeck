import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPlayback } from '../src/attachment-playback.js';

test('HLS playback attaches stream and releases media on close', () => {
    let instance;
    class FakeHls {
        static isSupported() { return true; }
        static Events = { ERROR: 'error' };
        constructor(config) { instance = this; this.config = config; }
        on(_event, handler) { this.handler = handler; }
        attachMedia(value) { this.element = value; }
        loadSource(value) { this.url = value; }
        destroy() { this.destroyed = true; }
    }
    const element = { pause() { this.paused = true; }, removeAttribute() { this.removed = true; }, load() { this.cleared = true; } };
    let error;
    const cleanup = attachPlayback(element, { kind: 'video', stream: 'hls', url: 'stream' }, value => { error = value; }, FakeHls);
    assert.equal(instance.element, element);
    assert.equal(instance.url, 'stream');
    instance.handler('error', { fatal: false });
    assert.equal(error, undefined);
    instance.handler('error', { fatal: true });
    assert.match(error, /Retry/);
    cleanup();
    assert.equal(instance.destroyed && element.paused && element.removed && element.cleared, true);
});
test('normal media does not require HLS support', () => {
    const element = { pause() {}, removeAttribute() {}, load() {} };
    attachPlayback(element, { kind: 'audio', url: 'audio' }, () => assert.fail());
    assert.equal(element.src, 'audio');
});
