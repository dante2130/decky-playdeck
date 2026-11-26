// Adapted from nexus-social, MIT, Xodus Nexus contributors.
const { findInReactTree, getReactRoot } = DFL;
const { createElement } = SP_REACT;
const registryKey = "__necroSteamMenuV1";
const entryPrefix = "necro-menu:";
const registryRevision = 5;
export const steamMenuPositions = [1, 2, 3, 4, 5, 6, 7, 8, 9];
function patchMountedMenu(registry) {
    const root = document.getElementById("root");
    if (!root)
        return;
    const menu = findInReactTree(getReactRoot(root), fiber => fiber?.memoizedProps?.navID === "MainNavMenuContainer");
    const parent = menu?.return;
    if (typeof parent?.type !== "function")
        return;
    const render = parent.type;
    const rowsSeen = new Set();
    const listsSeen = new Map();
    const wrappedTypes = new WeakMap();
    let active = true;
    const isSharedEntry = (row) => typeof row?.key === "string" &&
        (row.key.startsWith(entryPrefix) || (row.key === "steamcord" && row.props?.route === "/discord"));
    const removeSharedEntries = (rows) => {
        for (let index = rows.length - 1; index >= 0; index--) {
            if (isSharedEntry(rows[index]))
                rows.splice(index, 1);
        }
    };
    function renderMenu(...args) {
        const tree = render.apply(this, args);
        if (!active)
            return tree;
        const list = tree?.props?.children?.props?.children?.[0];
        if (typeof list?.type !== "function")
            return tree;
        const renderList = list.type;
        let wrapped = wrappedTypes.get(renderList);
        if (!wrapped) {
            wrapped = function (...listArgs) {
                const output = renderList.apply(this, listArgs);
                if (!active)
                    return output;
                const isNativeRoute = (row) => !isSharedEntry(row) && row?.props?.route &&
                    row.props.label && (row.props.onGamepadFocus || row.props.onFocus);
                const rows = findInReactTree(output, node => Array.isArray(node) && node.some(isNativeRoute));
                if (!Array.isArray(rows) || Object.isFrozen(rows))
                    return output;
                removeSharedEntries(rows);
                const template = rows.find(isNativeRoute);
                if (!template)
                    return output;
                rowsSeen.add(rows);
                if (rowsSeen.size > 32)
                    rowsSeen.delete(rowsSeen.values().next().value);
                const routes = rows.flatMap((row, index) => isNativeRoute(row) ? [index] : []);
                let position = 3;
                try {
                    const saved = Number(localStorage.getItem("STEAMCORD_MENU_POSITION") ?? 3);
                    if (Number.isInteger(saved) && saved >= 1 && saved <= 9)
                        position = saved;
                }
                catch { /* Use the default menu position when storage is unavailable. */ }
                const last = routes[routes.length - 1] + 1;
                const entries = [...registry.entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
                const insertions = new Map();
                for (const entry of entries) {
                    const slot = entry.position ?? position;
                    const index = (slot === 9 ? undefined : routes[slot - 1]) ?? last;
                    const insertion = insertions.get(index) ?? [];
                    insertion.push(createElement(template.type, {
                        key: entryPrefix + entry.id,
                        route: entry.route,
                        label: entry.label,
                        ...(template.props.onGamepadFocus ? { onGamepadFocus: template.props.onGamepadFocus } : { onFocus: template.props.onFocus }),
                        ...(template.props.icon ? { icon: entry.icon } : { children: entry.icon }),
                        ...(entry.onSecondary ? {
                            onSecondaryActionDescription: entry.secondaryActionDescription ?? "Change Position",
                            onSecondaryButton: entry.onSecondary,
                        } : {}),
                        ...(entry.onOptions ? {
                            onOptionsActionDescription: entry.optionsActionDescription,
                            onOptionsButton: entry.onOptions,
                        } : {}),
                    }));
                    insertions.set(index, insertion);
                }
                for (const [index, insertion] of [...insertions].sort(([a], [b]) => b - a)) {
                    rows.splice(index, 0, ...insertion);
                }
                return output;
            };
            wrappedTypes.set(renderList, wrapped);
            wrappedTypes.set(wrapped, wrapped);
        }
        if (wrapped !== renderList && !Object.isFrozen(list)) {
            listsSeen.set(list, { original: renderList, wrapper: wrapped });
            if (listsSeen.size > 32)
                listsSeen.delete(listsSeen.keys().next().value);
            list.type = wrapped;
        }
        return tree;
    }
    parent.type = renderMenu;
    if (parent.alternate)
        parent.alternate.type = renderMenu;
    return () => {
        active = false;
        if (parent.type === renderMenu)
            parent.type = render;
        if (parent.alternate?.type === renderMenu)
            parent.alternate.type = render;
        for (const [list, { original, wrapper }] of listsSeen) {
            if (list.type === wrapper)
                list.type = original;
        }
        listsSeen.clear();
        rowsSeen.forEach(removeSharedEntries);
        rowsSeen.clear();
    };
}
export function installSteamMainMenuEntry(route, icon, getPosition, onSecondary, onOptions) {
    const host = window;
    const registry = host[registryKey] ?? (host[registryKey] = { entries: new Map() });
    const entry = {
        id: "playdeck", route, icon, order: 40,
        label: "PlayDeck", onSecondary, onOptions,
        optionsActionDescription: "PlayDeck settings",
        get position() { return getPosition(); },
        get secondaryActionDescription() { return "Change menu position"; },
    };
    registry.entries.set(entry.id, entry);
    const stopRetrying = () => {
        clearInterval(registry.timer);
        registry.timer = undefined;
    };
    const ensurePatch = () => {
        if ((registry.revision ?? 0) < registryRevision) {
            // Steamcord can reinstall its older shared patch when it loads or reloads.
            stopRetrying();
            registry.dispose?.();
            registry.dispose = undefined;
            registry.revision = registryRevision;
        }
        if (registry.dispose || registry.timer !== undefined)
            return;
        let attempts = 0;
        const tryMount = () => {
            try {
                registry.dispose = patchMountedMenu(registry);
            }
            catch (error) {
                console.debug("PlayDeck: unable to patch the mounted Steam menu.", error);
            }
            if (registry.dispose || ++attempts >= 30)
                stopRetrying();
        };
        registry.timer = setInterval(tryMount, 2000);
        tryMount();
    };
    ensurePatch();
    const watchRevision = setInterval(() => {
        if ((registry.revision ?? 0) < registryRevision)
            ensurePatch();
    }, 1000);
    return () => {
        clearInterval(watchRevision);
        if (registry.entries.get(entry.id) !== entry)
            return;
        registry.entries.delete(entry.id);
        if (registry.entries.size)
            return;
        stopRetrying();
        registry.dispose?.();
        registry.dispose = undefined;
    };
}
