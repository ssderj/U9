import React, { createContext, useContext, useState, useRef, useEffect } from 'react';


// ---------- Universal navigation (Back button, breadcrumbs, scroll restoration) ----------
// A single history stack shared by the whole app — Home, the Grand Library, the Writer Profile,
// every Project Workspace tab, and anything nested inside them. Any screen that descends a level
// calls nav.push() with a breadcrumb label and an `undo` function that restores whatever was
// showing before. UniversalBackButton and Breadcrumbs both read this same stack, so Back always
// returns to wherever the reader actually came from (never hard-coded to Home), and the
// breadcrumb trail always matches exactly what Back will do.
export const NavContext = createContext(null);


export function useNav() {
    return useContext(NavContext);
}


// Type scale, deliberately consolidated to 8 steps (12 / 13 / 15 / 17 / 20 / 24 / 30 / 38,
// 12 is the floor for any reading text (raised from 11 in the UI polish pass: 11px secondary text was
// the most common 'too small / hard to read' complaint on phones),
// plus 6 and 46 kept as rare decorative/hero outliers). Every call site still reads
// TYPE_SCALE[N] with its original bare number as the key -- only the output pixel values
// changed, so no component code needed to change. This replaces the old literal registry
// (30+ near-duplicate sizes, most under 12px) that was the single biggest source of the
// small, busy text across the app -- see the UI clutter audit.
export const TYPE_SCALE = {
  6: 6,
  8.5: 12, 9: 12, 9.5: 12, 10: 12, 10.5: 12, 11: 12,
  11.5: 13, 12: 13, 12.5: 13, 13: 13,
  13.5: 15, 14: 15, 14.5: 15, 15: 15,
  15.5: 17, 16: 17, 17: 17,
  18: 20, 19: 20, 20: 20,
  21: 24, 22: 24, 24: 24, 25: 24, 26: 24,
  28: 30, 30: 30,
  32: 38, 34: 38, 38: 38,
  46: 46,
};


// Radius scale, consolidated to 5 real steps (4 / 8 / 12 / 16 / 20) plus the two special
// cases (100 = fully-rounded pill, 999 = circle). Same principle as TYPE_SCALE: same lookup
// keys, fewer distinct output values, so borders and corners read as one consistent family
// instead of a dozen near-identical roundings.
export const RADIUS_SCALE = {
  1: 4, 2: 4, 3: 4,
  4: 8, 5: 8, 6: 8, 7: 8, 8: 8, 9: 8,
  10: 12, 11: 12, 12: 12,
  14: 16, 15: 16, 16: 16, 18: 16,
  20: 20,
  100: 100, 999: 999,
};


// Space scale, tightened to a clean 4px-ish grid (2 / 4 / 8 / 12 / 16 / 20 / 24) so gaps and
// padding stop landing on odd, hard-to-tell-apart values like 18 vs 20 vs 22.
export const SPACE_SCALE = {
  1: 2, 2: 2,
  3: 4, 4: 4,
  5: 8, 6: 8, 7: 8, 8: 8,
  9: 12, 10: 12, 12: 12,
  14: 16, 16: 16,
  18: 20, 20: 20,
  22: 24, 24: 24,
};


export function NavigationProvider({ rootLabel, children }) {
    const [stack, setStack] = useState([{ label: rootLabel || 'Home', key: 'root' }]);
    // Scroll offsets keyed by a caller-chosen string (see NavScrollBox) so returning to a screen —
    // via Back, a breadcrumb click, or just switching tabs and back — restores exactly where the
    // reader left off instead of snapping to the top.
    const scrollPositions = useRef({});
    // Mirror this stack's depth onto the browser/device history so the hardware or edge-swipe
    // Back gesture retraces the same steps as UniversalBackButton and Breadcrumbs, instead of
    // leaving the app outright (nothing was ever pushed onto history before this) or landing on
    // a screen the in-app stack doesn't know about. Each push() adds one history entry tagged
    // with the resulting depth; pop()/goTo() drive the browser the same number of steps back
    // rather than touching history state directly, so this stays a thin mirror of the same stack
    // rather than a second, independent source of truth. The one popstate listener below is what
    // turns an external Back gesture into the same undo the in-app Back button runs — comparing
    // the depth on the entry being landed on against the current stack length makes it a no-op
    // whenever the change already came from push()/pop()/goTo() themselves, so real (external)
    // and self-driven history moves can share one handler without double-firing.
    useEffect(() => {
        if (!window.history.state || typeof window.history.state.inkNavDepth !== 'number') {
            window.history.replaceState({ inkNavDepth: 1 }, '');
        }
        const onPopState = (e) => {
            const targetDepth = (e.state && typeof e.state.inkNavDepth === 'number') ? e.state.inkNavDepth : 1;
            setStack((s) => {
                // Exact match means this popstate is the trailing echo of a push()/pop()/goTo()
                // we already applied ourselves — a genuine no-op, not a missed navigation.
                if (targetDepth === s.length)
                    return s;
                if (targetDepth > s.length) {
                    // targetDepth can only exceed the current stack here because resetTo() (see
                    // below) relabels just the CURRENT history entry when it collapses the stack,
                    // leaving every OLDER real history entry still stamped with its pre-reset
                    // depth. Landing back on one of those stale entries used to look identical to
                    // "nothing to do" (targetDepth >= s.length was one no-op condition), so Back
                    // silently did nothing — for as many taps as there were stale entries between
                    // here and wherever resetTo() was called from — instead of returning to Home.
                    // resetTo() already discarded whatever those older levels meant (the whole
                    // point of resetTo is that undoing back into them "no longer makes sense"), so
                    // the correct target for this tap is the same place resetTo() itself unwound
                    // to: run every remaining undo and land on Home. Re-stamping the entry we just
                    // arrived on with the CURRENT (correct) depth means the next stale entry, if
                    // any, resyncs the same way instead of drifting further out of step.
                    for (let i = s.length - 1; i >= 1; i--) {
                        if (s[i] && s[i].undo)
                            s[i].undo();
                    }
                    window.history.replaceState({ inkNavDepth: 1 }, '');
                    return s.slice(0, 1);
                }
                for (let i = s.length - 1; i >= targetDepth; i--) {
                    if (s[i] && s[i].undo)
                        s[i].undo();
                }
                return s.slice(0, targetDepth);
            });
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);
    const push = (entry) => {
        setStack((s) => {
            const next = [...s, { key: entry.label + ':' + s.length + ':' + Date.now(), ...entry }];
            window.history.pushState({ inkNavDepth: next.length }, '');
            return next;
        });
    };
    const pop = () => {
        setStack((s) => {
            if (s.length <= 1)
                return s;
            const leaving = s[s.length - 1];
            if (leaving.undo)
                leaving.undo();
            window.history.back();
            return s.slice(0, -1);
        });
    };
    const goTo = (index) => {
        setStack((s) => {
            if (index >= s.length - 1 || index < 0)
                return s;
            // Undo every level from the top down to (but not including) the target, so jumping
            // straight to a breadcrumb three levels up leaves state exactly as three Backs would.
            for (let i = s.length - 1; i > index; i--) {
                if (s[i].undo)
                    s[i].undo();
            }
            window.history.go(index + 1 - s.length);
            return s.slice(0, index + 1);
        });
    };
    // Swaps the current top-of-stack entry for a new one at the SAME depth — used when moving
    // directly between two sibling tabs (e.g. Guild Hall -> Grand Library) without unwinding
    // through Home first. This undoes the outgoing entry and rewrites the browser's current
    // history entry in place with replaceState (synchronous), instead of the previous approach of
    // combining an async `window.history.go(-1)` with an immediate `pushState()` right after it.
    // That combination raced the browser's own pending back-navigation against our forward push:
    // the delayed popstate for the go(-1) would land *after* the push had already completed, and
    // — mistaking the swap for a real Back — fire the new entry's own `undo` (which just sets the
    // tab back to Home), snapping the screen back to Home right after the tap looked like it
    // worked. Tapping again "fixed" it only because the stray popstate had settled by then.
    // replaceState never asks the browser to traverse history, so there's no async step to race.
    const replaceTop = (entry) => {
        setStack((s) => {
            if (s.length < 2)
                return s;
            const leaving = s[s.length - 1];
            if (leaving.undo)
                leaving.undo();
            const next = [...s.slice(0, -1), { key: entry.label + ':' + (s.length - 1) + ':' + Date.now(), ...entry }];
            window.history.replaceState({ inkNavDepth: next.length }, '');
            return next;
        });
    };
    // Used when a whole new top-level context replaces the current one outright (deleting the
    // project you're standing in, for instance) rather than descending from it — trail restarts
    // from Home instead of trying to undo a screen that no longer makes sense. Only the current
    // history entry is relabeled (not unwound step-by-step, since there's no single "undo" this
    // jump corresponds to). Real browser history entries further back keep their pre-reset depth
    // stamps, so a later Back tap can land on one of those and report a depth greater than this
    // (now-shorter) stack — the popstate handler above treats that case as "unwind the rest of
    // the way to Home" specifically so that landing there resolves in one tap instead of silently
    // no-op'ing once per stale entry.
    const resetTo = (entry) => {
        window.history.replaceState({ inkNavDepth: entry ? 2 : 1 }, '');
        setStack(entry ? [{ label: rootLabel || 'Home', key: 'root' }, entry] : [{ label: rootLabel || 'Home', key: 'root' }]);
    };
    const saveScroll = (key, top) => { scrollPositions.current[key] = top; };
    const getScroll = (key) => scrollPositions.current[key] || 0;
    const value = { stack, push, pop, goTo, resetTo, replaceTop, saveScroll, getScroll };
    return React.createElement(NavContext.Provider, { value }, children);
}


// Returns the page to the top. The window (not an inner box) is what scrolls in this app, and nothing used to
// reset it, so a screen opened from halfway down another could open halfway down itself, and tapping the
// bottom-bar tab you were already on did nothing. `smooth` is for the deliberate "tap the active tab" gesture;
// a screen change jumps instantly. Respects prefers-reduced-motion. Never throws.
export function scrollPageToTop(smooth) {
    try {
        const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, left: 0, behavior: smooth && !reduce ? 'smooth' : 'auto' });
    }
    catch (e) {
        try { window.scrollTo(0, 0); } catch (e2) { }
    }
}


// Locks the page's own scroll while a full-screen overlay (a modal, drawer, or similar) is
// showing on top of it, so the content underneath can't still be scrolled — via wheel, touch
// drag, or arrow keys — at the same time the overlay itself scrolls. Restores whatever
// `overflow` was already set on <body> beforehand on cleanup/close, so it composes safely
// however many times it's used across the app rather than assuming it owns that style outright.
export function useBodyScrollLock(active) {
    useEffect(() => {
        if (!active)
            return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [active]);
}


// ---------- Pop-up (dialog) behaviour ----------
// One shared helper so every pop-up in the app behaves like a proper dialog, not just looks like one:
//   - Escape closes it (only the TOPMOST open pop-up, so a confirm box over a panel closes alone);
//   - keyboard focus moves into it when it opens, Tab / Shift+Tab stay inside it, and focus goes back to
//     whatever opened it when it closes;
//   - dialogProps() labels it for screen readers (role="dialog", aria-modal, aria-label).
// Usage inside a pop-up component:   const dlgRef = useDialogBehavior(onClose);
// and on its outermost element:      { ref: dlgRef, ...dialogProps('Cart'), ...the rest }
// Pass `null` as onClose for a pop-up that must NOT close on Escape (a forced choice, or one that already
// handles Escape itself). Focus lands on the pop-up's own frame rather than its first field, on purpose:
// focusing a text field would pop the on-screen keyboard open on a phone the moment a pop-up appears.
// This does not lock page scroll; that stays with useBodyScrollLock / each screen, as before.
const openDialogs = [];
const DIALOG_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function dialogProps(label) {
    return { role: 'dialog', 'aria-modal': 'true', 'aria-label': label || undefined, tabIndex: -1 };
}

export function useDialogBehavior(onClose, active = true) {
    const ref = useRef(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        if (!active)
            return undefined;
        const token = {};
        openDialogs.push(token);
        const prevFocus = document.activeElement;
        const node = ref.current;
        if (node && !node.contains(document.activeElement)) {
            try { node.focus({ preventScroll: true }); } catch (e) { }
        }
        const onKey = (e) => {
            if (openDialogs[openDialogs.length - 1] !== token)
                return;
            if (e.key === 'Escape') {
                if (!e.defaultPrevented && !e.isComposing && typeof closeRef.current === 'function') {
                    e.preventDefault();
                    closeRef.current();
                }
                return;
            }
            if (e.key !== 'Tab' || !node)
                return;
            const items = Array.from(node.querySelectorAll(DIALOG_FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
            if (!items.length) {
                e.preventDefault();
                node.focus();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const current = document.activeElement;
            if (e.shiftKey && (current === first || current === node || !node.contains(current))) {
                e.preventDefault();
                last.focus();
            }
            else if (!e.shiftKey && (current === last || !node.contains(current))) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            const at = openDialogs.indexOf(token);
            if (at >= 0)
                openDialogs.splice(at, 1);
            if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
                try { prevFocus.focus({ preventScroll: true }); } catch (e) { }
            }
        };
    }, [active]);
    return ref;
}


// Consistent Back button for every page in the app. Always labeled with, and always returns to,
// whatever page the reader actually came from — not a hard-coded trip to Home.
//   phoneOnly: hide it from 640px up, where the breadcrumb trail (see Breadcrumbs) does the same job.
//   label/onClick: override for a screen whose "one level up" is not the previous stack entry
//   (the Guild Order goes back to the Guild Hall, which is a sibling tab rather than a stack level).
// 44px tall on every screen so it is an easy thumb target. Drawn as quiet text with no box (the old
// bordered pill competed with the screen's own headline); the arrow sits flush with the page edge.
export function UniversalBackButton({ style, compact, phoneOnly, label, onClick }) {
    const nav = useNav();
    const hasOverride = typeof onClick === 'function';
    if (!hasOverride && (!nav || nav.stack.length <= 1))
        return null;
    const prev = nav && nav.stack.length > 1 ? nav.stack[nav.stack.length - 2] : null;
    const text = label || (prev && prev.label) || 'Back';
    return React.createElement("button", {
        onClick: hasOverride ? onClick : () => nav.pop(), className: "ink-universal-back" + (phoneOnly ? " ink-hide-wide" : ""), title: "Back to " + text,
        "aria-label": "Back to " + text,
        style: Object.assign({
            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none',
            border: 'none', color: '#A39C8C', borderRadius: RADIUS_SCALE[8],
            minHeight: 44, padding: compact ? '5px 12px 5px 0' : '7px 14px 7px 0', fontSize: compact ? 13 : 15, cursor: 'pointer',
            fontFamily: 'inherit', transition: 'color var(--ink-dur) var(--ink-ease)',
        }, style),
    }, "\u2190 ", text);
}


// One-line "you are here" for phones, where the full trail (see Breadcrumbs) is hidden: the parent level in
// quiet grey (tap it to go up, same as Back) followed by the current screen in bold. Only the last two levels
// are shown, and both truncate with an ellipsis, so it always stays on one line however long a book title is.
// Hidden from 640px up (.ink-hide-wide), where Breadcrumbs shows the whole trail instead.
export function PhoneTrail({ style }) {
    const nav = useNav();
    if (!nav || nav.stack.length <= 1)
        return null;
    const n = nav.stack.length;
    const current = nav.stack[n - 1];
    const parent = nav.stack[n - 2];
    return React.createElement("div", { className: "ink-hide-wide ink-phone-trail", style: Object.assign({
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4], minWidth: 0, fontSize: TYPE_SCALE[13],
        }, style) },
        React.createElement("button", {
            type: 'button', onClick: () => nav.pop(), title: "Back to " + parent.label, "aria-label": "Back to " + parent.label,
            style: {
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4], minHeight: 44, padding: '0 4px 0 0',
                background: 'none', border: 'none', color: '#8A8A92', font: 'inherit', cursor: 'pointer',
                flex: '0 1 auto', minWidth: 0, maxWidth: '45%',
            },
        },
            React.createElement("span", { "aria-hidden": "true", style: { fontSize: TYPE_SCALE[17], lineHeight: 1 } }, "\u2039"),
            React.createElement("span", { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, parent.label)),
        React.createElement("span", { "aria-hidden": "true", style: { opacity: 0.5 } }, "\u203A"),
        React.createElement("span", { "aria-current": "page", style: {
                flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: '#EFE7D2', fontWeight: 600,
            } }, current.label));
}


// Breadcrumb trail, e.g. Home › Grand Library › Book › Reviews. Shown from 640px up only (see .ink-crumbs
// in app.css): on a phone the Back button is the way up a level. Every crumb but the last is
// clickable and jumps straight back to that level via nav.goTo — same restore logic Back uses.
export function Breadcrumbs({ style }) {
    const nav = useNav();
    if (!nav || nav.stack.length <= 1)
        return null;
    return React.createElement("div", { className: "ink-crumbs", style: Object.assign({
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[12.5],
            color: '#8A8A92', marginBottom: 14,
        }, style) },
        nav.stack.map((entry, i) => {
            const isLast = i === nav.stack.length - 1;
            return React.createElement(React.Fragment, { key: entry.key },
                i > 0 && React.createElement("span", { style: { opacity: 0.5, padding: '0 2px' } }, "\u203A"),
                React.createElement("button", {
                    onClick: () => !isLast && nav.goTo(i), disabled: isLast,
                    style: {
                        background: 'none', border: 'none', padding: '2px 3px', font: 'inherit',
                        color: isLast ? '#EFE7D2' : '#8A8A92', fontWeight: isLast ? 600 : 400,
                        cursor: isLast ? 'default' : 'pointer',
                    },
                }, entry.label));
        }));
}


// Wraps a scrollable region so its scroll position survives navigating away and back — through
// Back, a breadcrumb jump, or switching tabs and returning. `navKey` should be unique to the
// content shown (include a project/book id and tab) so different screens don't share one offset.
export function NavScrollBox({ navKey, className, style, children }) {
    const nav = useNav();
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || !nav)
            return;
        el.scrollTop = nav.getScroll(navKey);
        const onScroll = () => nav.saveScroll(navKey, el.scrollTop);
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            nav.saveScroll(navKey, el.scrollTop);
            el.removeEventListener('scroll', onScroll);
        };
    }, [navKey]);
    return React.createElement("div", { ref, className, style }, children);
}
