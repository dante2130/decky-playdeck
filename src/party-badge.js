// Adapted from nexus-social, MIT, Xodus Nexus contributors.
const { afterPatch, findClassModule, findModule, Focusable } = DFL;
const { cloneElement, createElement, useEffect, useState, useSyncExternalStore } = SP_REACT;
const headerClasses = findClassModule(value => value.HeaderItem && value.Clickable && value.Clock);
const badgeKey = "playdeck-party-badge";
function PartyBadge({ count, onOpen, native }) {
    const [focused, setFocused] = useState(false);
    const label = `Open PlayStation party, ${count} ${count === 1 ? "member" : "members"}`;
    const className = [headerClasses?.HeaderItem, headerClasses?.Clickable, focused && "playdeck-party-focused"].filter(Boolean).join(" ");
    const style = {
        display: "inline-flex", alignItems: "center", justifyContent: "center", position: "relative",
        width: 36, minWidth: 0, height: "100%", alignSelf: "stretch", flexShrink: 0,
        border: 0, padding: 0, borderRadius: 0, color: "inherit", cursor: "pointer", touchAction: "manipulation",
    };
    const content = SP_REACT.createElement(SP_REACT.Fragment, null,
        SP_REACT.createElement("style", null, `
      button:where([data-playdeck-party-badge]) { appearance: none; background: transparent; }
      @media (hover: hover) {
        [data-playdeck-party-badge]:hover { background-color: rgb(255 255 255 / 12%); }
      }
      [data-playdeck-party-badge]:active { background-color: rgb(255 255 255 / 24%); }
      [data-playdeck-party-badge]:is(.playdeck-party-focused, .gpfocus, :focus-visible) {
        background: #fff !important; color: #0e141b !important;
        box-shadow: none !important; outline: none !important;
      }
      [data-playdeck-party-badge]:is(.playdeck-party-focused, .gpfocus, :focus-visible) .playdeck-party-count {
        background: #0e141b !important; color: #fff !important;
      }
    `),
        SP_REACT.createElement("svg", { width: "21", height: "21", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" },
            SP_REACT.createElement("path", { d: "M12 3a9 9 0 0 0-9 9v4a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5.1a7 7 0 0 1 13.8 0H17a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h.7a3 3 0 0 1-2.7 2h-2v2h2a5 5 0 0 0 5-4.5 3 3 0 0 0 1-2.5v-4a9 9 0 0 0-9-9Z" })),
        SP_REACT.createElement("span", { className: "playdeck-party-count", "aria-hidden": "true", style: {
                position: "absolute", top: 2, right: 0, minWidth: 12, height: 12, padding: "0 2px",
                boxSizing: "border-box", lineHeight: "12px", borderRadius: 8, background: "#75b84e",
                color: "#101910", fontSize: 9, fontWeight: "bold", textAlign: "center",
            } }, count));
    if (!native)
        return SP_REACT.createElement("button", { type: "button", tabIndex: -1, className: className, "data-playdeck-party-badge": true, "aria-label": label, style: style, onMouseDown: event => event.preventDefault(), onClick: onOpen }, content);
    return SP_REACT.createElement(Focusable, { noFocusRing: true, className: className, role: "button", "data-playdeck-party-badge": true, onGamepadFocus: () => setFocused(true), onGamepadBlur: () => setFocused(false), onMouseEnter: () => setFocused(false), onMouseMove: () => setFocused(false), onOKActionDescription: "Open PlayStation party", onActivate: onOpen, onClick: onOpen, "aria-label": label, style: style }, content);
}
function headerNavigationProviders(header) {
    const fiberKey = Object.keys(header).find(key => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? header[fiberKey] : null;
    const providers = [];
    let foundNavigation = false;
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
        if (fiber.tag !== 10)
            continue;
        const context = fiber.type?._context ?? fiber.type;
        const type = context?.Provider;
        if (!type)
            continue;
        const value = fiber.memoizedProps?.value;
        if (value?.m_Tree && Array.isArray(value?.m_rgChildren))
            foundNavigation = true;
        providers.push({ type, value });
    }
    return foundNavigation ? providers : [];
}
function HeaderPortal({ active, renderBadge }) {
    const [host, setHost] = useState(null);
    const [providers, setProviders] = useState([]);
    useEffect(() => {
        if (!active)
            return;
        let node = null;
        let observer;
        let observed;
        const attach = () => {
            const store = window.SteamUIStore;
            const win = store?.WindowStore?.GamepadUIMainWindowInstance?.BrowserWindow?.window;
            const doc = win?.document;
            if (!doc)
                return;
            if (observed !== doc) {
                observer?.disconnect();
                observed = doc;
                observer = new MutationObserver(attach);
                observer.observe(doc.documentElement, { childList: true, subtree: true });
            }
            const header = doc.getElementById("header");
            if (!header)
                return;
            const native = Array.from(header.querySelectorAll("[data-playdeck-party-badge]")).find(item => !node?.contains(item));
            if (native) {
                if (node) {
                    node.remove();
                    node = null;
                    setHost(null);
                }
                return;
            }
            const nextProviders = headerNavigationProviders(header);
            setProviders(previous => previous.length === nextProviders.length && previous.every((provider, index) => provider.type === nextProviders[index].type && provider.value === nextProviders[index].value) ? previous : nextProviders);
            if (node?.parentElement === header)
                return;
            node?.remove();
            node = doc.createElement("div");
            node.className = "playdeck-party-status-host";
            Object.assign(node.style, { display: "flex", alignItems: "stretch", alignSelf: "stretch", height: "100%", flexShrink: "0", pointerEvents: "auto" });
            const clock = Array.from(header.children).find(child => /[0-9]{1,2}:[0-9]{2}/.test(child.textContent || ""));
            header.insertBefore(node, clock || header.lastElementChild);
            setHost(node);
        };
        attach();
        const timer = setInterval(attach, 1000);
        return () => { clearInterval(timer); observer?.disconnect(); node?.remove(); setHost(null); };
    }, [active]);
    if (!host || !active)
        return null;
    const dom = window.SP_REACTDOM;
    let content = renderBadge(providers.length > 0);
    // Walk from the closest provider outwards, matching the target header ancestry.
    for (const provider of providers)
        content = createElement(provider.type, { value: provider.value }, content);
    return dom?.createPortal(content, host) ?? null;
}
export function installPartyBadge(routerHook, onOpen) {
    let count = 0;
    const listeners = new Set();
    const subscribe = (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    };
    const snapshot = () => count;
    function Badge() {
        const members = useSyncExternalStore(subscribe, snapshot);
        return members > 0 ? SP_REACT.createElement(PartyBadge, { count: members, onOpen: onOpen, native: true }) : null;
    }
    function Fallback() {
        const members = useSyncExternalStore(subscribe, snapshot);
        return SP_REACT.createElement(HeaderPortal, { active: members > 0, renderBadge: native => SP_REACT.createElement(PartyBadge, { count: members, onOpen: onOpen, native: native }) });
    }
    routerHook.addGlobalComponent(badgeKey, Fallback);
    const module = findModule((value) => typeof value === "object" && Object.values(value).some((item) => typeof item?.type === "function" && item.type.toString().includes("quickAccessHeader") && item.type.toString().includes("BShowHeader")));
    const headers = module ? Object.values(module).filter((item) => typeof item?.type === "function"
        && item.type.toString().includes("quickAccessHeader") && item.type.toString().includes("BShowHeader")) : [];
    const patches = headers.map(header => afterPatch(header, "type", (_args, tree) => {
        if (Array.isArray(tree?.props?.children)) {
            if (tree.props.children.some((item) => item?.key === badgeKey))
                return tree;
            return cloneElement(tree, {}, SP_REACT.createElement(Badge, { key: badgeKey }), ...tree.props.children);
        }
        const row = tree?.props?.children;
        const groups = row?.props?.children;
        if (!Array.isArray(groups))
            return tree;
        let index = groups.length - 1;
        while (index >= 0 && !Array.isArray(groups[index]?.props?.children))
            index--;
        if (index < 0)
            return tree;
        const group = groups[index];
        const items = group.props.children;
        if (items.some((item) => item?.key === badgeKey))
            return tree;
        const updated = [...groups];
        updated[index] = cloneElement(group, {}, SP_REACT.createElement(Badge, { key: badgeKey }), ...items);
        return cloneElement(tree, {}, cloneElement(row, {}, ...updated));
    }));
    return {
        update(members) {
            if (members === count)
                return;
            count = members;
            listeners.forEach(listener => listener());
        },
        remove() {
            this.update(0);
            routerHook.removeGlobalComponent(badgeKey);
            patches.reverse().forEach(patch => patch.unpatch());
            listeners.clear();
        },
    };
}
