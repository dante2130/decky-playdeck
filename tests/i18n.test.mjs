import test from 'node:test';
import assert from 'node:assert/strict';
import ru from '../src/locales/ru.js';
import uk from '../src/locales/uk.js';

test('catalogs have matching keys and placeholders', () => {
    assert.deepEqual(Object.keys(ru).sort(), Object.keys(uk).sort());
    const placeholders = text => [...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
    for (const key of Object.keys(ru)) {
        assert.deepEqual(placeholders(ru[key]), placeholders(key));
        assert.deepEqual(placeholders(uk[key]), placeholders(key));
    }
});

test('language defaults to Steam and saves a manual override', async () => {
    const saved = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: key => saved.get(key),
        setItem: (key, value) => saved.set(key, value),
    } });
    globalThis.SteamClient = { Settings: { GetCurrentLanguage: async () => 'ukrainian' } };
    globalThis.SP_REACT = { useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
    try {
        const locale = await import('../src/i18n.js');
        await locale.initializeLanguage();
        assert.deepEqual(locale.useLanguage(), { preference: 'system', language: 'uk' });
        assert.equal(locale.t('Friends'), 'Друзі');
        locale.setLanguage('ru');
        assert.deepEqual(locale.useLanguage(), { preference: 'ru', language: 'ru' });
        assert.equal(locale.t('Connected as {name}', { name: 'Alex' }), 'Вы вошли как Alex');
        const reloaded = await import('../src/i18n.js?reloaded');
        await reloaded.initializeLanguage();
        assert.equal(reloaded.t('Friends'), 'Друзья');
        locale.setLanguage('en');
        assert.equal(locale.t('Friends'), 'Friends');
    }
    finally {
        delete globalThis.localStorage;
        delete globalThis.SteamClient;
        delete globalThis.SP_REACT;
    }
});
