import React, { useEffect, useState } from 'react';
import { InkIcon } from '../shell/ink-icon.jsx';

// Marketplace structure (department tabs, two-up product grid, floating cart button). Layout only:
// every handler and data value is passed in by grand-library-screen.jsx / the three card wrappers.
export function MarketplaceStyles() {
    return React.createElement("style", null, `
      .mk-dept { display: flex; gap: 18px; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid #3A3020; margin-bottom: 10px; }
      .mk-dept::-webkit-scrollbar { display: none; }
      .mk-dept button { flex-shrink: 0; background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; min-height: 44px; padding: 0 2px; font-family: inherit; font-size: 13px; font-weight: 600; color: #A39C8C; cursor: pointer; white-space: nowrap; }
      .mk-dept button:hover { color: #EFE7D2; }
      .mk-dept button[aria-selected="true"] { color: #F4EEDD; border-bottom-color: #F4EEDD; }
      .mk-count { font-size: 13px; color: #A39C8C; margin: 0 2px 12px; }
      .mk-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      @media (min-width: 640px) { .mk-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); } }
      .mk-tile { display: flex; flex-direction: column; min-width: 0; background: #16161A; border: 1px solid #3A3020; border-radius: 12px; overflow: hidden; transition: border-color var(--ink-dur) var(--ink-ease); }
      .mk-tile:hover { border-color: #4A3D22; }
      .mk-media { position: relative; aspect-ratio: 1 / 1; display: flex; align-items: center; justify-content: center; background-color: #1C1810; background-size: cover; background-position: center; cursor: pointer; font-size: 40px; }
      .mk-badge { position: absolute; top: 8px; left: 8px; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: rgba(16,14,10,0.82); color: #D9D2BE; border: 1px solid #3A3020; max-width: calc(100% - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mk-body { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px 12px; flex: 1; min-width: 0; }
      .mk-title { font-family: 'Fraunces', Georgia, serif; font-size: 14px; font-weight: 600; line-height: 1.3; color: #EFE7D2; cursor: pointer; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .mk-by, .mk-meta { font-size: 13px; color: #A39C8C; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mk-price { font-size: 17px; font-weight: 600; color: #F4EEDD; margin-top: 4px; }
      .mk-price.free { color: #8FCB8F; }
      .mk-btn { margin-top: 8px; min-height: 44px; border-radius: 999px; background: none; border: 1px solid #4A3D22; color: #EFE7D2; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .mk-btn:hover { border-color: #D9D2BE; }
      .mk-done { margin-top: 8px; min-height: 44px; display: flex; align-items: center; justify-content: center; font-size: 13px; color: #A39C8C; }
      .mk-fab-wrap { position: fixed; right: 16px; bottom: calc(20px + env(safe-area-inset-bottom, 0px)); z-index: 40; display: flex; flex-direction: column-reverse; align-items: flex-end; gap: 10px; }
      .mk-fab { position: relative; width: 56px; height: 56px; border-radius: 50%; border: none; background: #E8C468; color: #17130E; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,0.5); transition: transform 120ms var(--ink-ease); }
      .mk-fab:active { transform: scale(0.94); }
      .mk-fab-badge { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 999px; background: #F4EEDD; color: #17130E; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 2px solid #100E0A; box-sizing: border-box; }
      .mk-dial { display: flex; align-items: center; gap: 10px; background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; }
      .mk-dial-label { font-size: 13px; font-weight: 600; color: #EFE7D2; background: #16161A; border: 1px solid #3A3020; border-radius: 999px; padding: 8px 12px; }
      .mk-dial-dot { position: relative; width: 44px; height: 44px; border-radius: 50%; background: #1C1810; border: 1px solid #4A3D22; color: #EFE7D2; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.45); }
      .mk-dial:hover .mk-dial-dot { border-color: #D9D2BE; }
      .mk-scrim { position: fixed; inset: 0; z-index: 39; background: rgba(10,9,7,0.4); }
    `);
}

// One product tile: media on top, then title, creator, a meta line, price and a single action.
export function MarketTile({ media, mediaStyle, badge, title, by, meta, price, free, actionLabel, onAction, onOpen, doneText }) {
    return React.createElement("div", { className: "mk-tile" },
        React.createElement("div", { className: "mk-media", onClick: onOpen, style: mediaStyle },
            media,
            badge && React.createElement("span", { className: "mk-badge" }, badge)),
        React.createElement("div", { className: "mk-body" },
            React.createElement("div", { className: "mk-title", onClick: onOpen }, title),
            by && React.createElement("div", { className: "mk-by" }, by),
            meta && React.createElement("div", { className: "mk-meta" }, meta),
            React.createElement("div", { className: `mk-price${free ? ' free' : ''}` }, price),
            doneText
                ? React.createElement("div", { className: "mk-done" }, doneText)
                : React.createElement("button", { className: "mk-btn", onClick: onAction || onOpen }, actionLabel)));
}

export function MarketDepartments({ tabs, value, onChange }) {
    return React.createElement("div", { className: "mk-dept", role: "tablist", "aria-label": "Marketplace departments" },
        tabs.map((t) => React.createElement("button", { key: t.key, role: "tab", "aria-selected": value === t.key, onClick: () => onChange(t.key) }, `${t.label} ${t.count}`)));
}

// Small circle near the lower edge. Tap to open a short dial: Cart first, then jumps to other parts of the page.
export function LibraryFab({ cartCount, inboxCount, onOpenCart, onOpenInbox }) {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);
    const jump = (id) => {
        setOpen(false);
        const el = id ? document.getElementById(id) : null;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const behavior = reduce ? 'auto' : 'smooth';
        if (el) el.scrollIntoView({ behavior, block: 'start' });
        else window.scrollTo({ top: 0, behavior });
    };
    const items = [
        { key: 'cart', icon: 'cart', label: cartCount > 0 ? `Cart (${cartCount})` : 'Cart', run: () => { setOpen(false); onOpenCart(); } },
        onOpenInbox && { key: 'inbox', icon: 'bell', label: inboxCount > 0 ? `Inbox (${inboxCount})` : 'Inbox', run: () => { setOpen(false); onOpenInbox(); } },
        { key: 'market', icon: 'package', label: 'Marketplace', run: () => jump('lib-marketplace') },
        { key: 'browse', icon: 'library', label: 'Browse all', run: () => jump('lib-browse') },
        { key: 'top', icon: 'search', label: 'Top', run: () => jump(null) },
    ].filter(Boolean);
    return React.createElement(React.Fragment, null,
        open && React.createElement("div", { className: "mk-scrim", onClick: () => setOpen(false), "aria-hidden": "true" }),
        React.createElement("div", { className: "mk-fab-wrap" },
            React.createElement("button", { className: "mk-fab", "aria-label": open ? 'Close quick menu' : 'Open cart and quick menu', "aria-expanded": open, onClick: () => setOpen((v) => !v) },
                React.createElement(InkIcon, { name: open ? 'close' : 'cart', size: 24 }),
                !open && cartCount > 0 && React.createElement("span", { className: "mk-fab-badge" }, cartCount)),
            open && items.map((it) => React.createElement("button", { key: it.key, className: "mk-dial", onClick: it.run },
                React.createElement("span", { className: "mk-dial-label" }, it.label),
                React.createElement("span", { className: "mk-dial-dot" }, React.createElement(InkIcon, { name: it.icon, size: 18 }))))));
}
