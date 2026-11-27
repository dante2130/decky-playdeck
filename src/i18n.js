import ru from "./locales/ru.js";
import uk from "./locales/uk.js";

const catalogs = { ru, uk };
const storageKey = "PLAYDECK_LANGUAGE";
const listeners = new Set();
export const languageOptions = [
    { data: "system", label: "System language" },
    { data: "en", label: "English" },
    { data: "ru", label: "Русский" },
    { data: "uk", label: "Українська" },
];
function resolveLanguage(locale) {
    const prefix = locale?.trim().toLowerCase().split(/[-_]/)[0];
    if (prefix === "ru" || prefix === "russian") return "ru";
    if (prefix === "uk" || prefix === "ukrainian") return "uk";
    return "en";
}
function readPreference() {
    try {
        const saved = globalThis.localStorage?.getItem(storageKey);
        return languageOptions.some(option => option.data === saved) ? saved : "system";
    }
    catch {
        return "system";
    }
}
let preference = readPreference();
let systemLanguage = resolveLanguage(globalThis.navigator?.language);
let current = { preference, language: preference === "system" ? systemLanguage : preference };
function updateLanguage() {
    const language = preference === "system" ? systemLanguage : preference;
    if (current.preference === preference && current.language === language)
        return;
    current = { preference, language };
    listeners.forEach(listener => listener());
}
function subscribe(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
const getLanguage = () => current;
export function useLanguage() {
    return SP_REACT.useSyncExternalStore(subscribe, getLanguage);
}
export async function initializeLanguage() {
    try {
        const locale = await globalThis.SteamClient?.Settings?.GetCurrentLanguage();
        systemLanguage = resolveLanguage(locale?.trim() || globalThis.navigator?.language);
    }
    catch {
        systemLanguage = resolveLanguage(globalThis.navigator?.language);
    }
    updateLanguage();
}
export function setLanguage(next) {
    if (!languageOptions.some(option => option.data === next))
        return;
    globalThis.localStorage.setItem(storageKey, next);
    preference = next;
    updateLanguage();
    if (next === "system")
        void initializeLanguage();
}
export function t(key, values = {}) {
    const catalog = catalogs[current.language];
    const text = catalog && Object.hasOwn(catalog, key) ? catalog[key] : key;
    return text.replace(/\{(\w+)\}/g, (token, name) => String(values[name] ?? token));
}
export function translateError(error) {
    const message = error.replace(/^ValueError:\s*/, "");
    const psn = /^PlayStation Network returned HTTP (\d+)( \(PSN code \d+\))?\.$/.exec(message);
    return psn ? t("PlayStation Network returned HTTP {status}{detail}.", { status: psn[1], detail: psn[2] ?? "" }) : t(message);
}
