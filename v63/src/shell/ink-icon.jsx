import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from './nav-context.jsx';


// ---------- Ink line-icon set ----------
// A small custom SVG icon set standing in for raw emoji glyphs across Home's navigation and
// Quick Access. Emoji render inconsistently across iOS/Android/desktop and read as generic app
// chrome rather than matching the hand-drawn medieval/parchment feel used everywhere else (the
// wooden table, the tree rail, the bookshelf). Every glyph is a plain 24x24 stroke icon that
// uses currentColor for its stroke (and, for the couple of small filled dots, its fill too), so
// it automatically inherits whatever gold/muted tint its parent button already applies for
// active/inactive state — no separate color logic needed at each call site. Add a new key to
// ICON_PATHS to extend the set; InkIcon and its sizing/color props stay the same.
export const ICON_PATHS = {
    home: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,11.5 L12,4.5 L20,11.5" }),
        React.createElement("path", { d: "M6.5,10 V19 A1,1 0 0,0 7.5,20 H16.5 A1,1 0 0,0 17.5,19 V10" }),
        React.createElement("path", { d: "M10,20 V14.5 H14 V20" })),
    guild: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,3.5 L18.5,6 V11.5 C18.5,16 15.5,19 12,20.5 C8.5,19 5.5,16 5.5,11.5 V6 Z" }),
        React.createElement("path", { d: "M9,10.5 L12,12.5 L15,10.5" })),
    library: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,19 V5.6 C4,5.3 4.3,5 4.6,5 H7.4 C7.7,5 8,5.3 8,5.6 V19" }),
        React.createElement("path", { d: "M9.5,19 V4.6 C9.5,4.3 9.8,4 10.1,4 H12.9 C13.2,4 13.5,4.3 13.5,4.6 V19" }),
        React.createElement("path", { d: "M15,19 V6.6 C15,6.3 15.3,6 15.6,6 H18.4 C18.7,6 19,6.3 19,6.6 V19" }),
        React.createElement("path", { d: "M3.5,19 H19.5" })),
    universe: React.createElement(React.Fragment, null,
        React.createElement("ellipse", { cx: 12, cy: 12, rx: 8.5, ry: 3.6, transform: "rotate(-20 12 12)" }),
        React.createElement("circle", { cx: 12, cy: 12, r: 1.7, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 18.3, cy: 6.2, r: 0.8, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 5.4, cy: 17.6, r: 0.6, fill: "currentColor", stroke: "none" })),
    inbox: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 3.5, y: 6, width: 17, height: 13, rx: 1.4 }),
        React.createElement("path", { d: "M4,7 L12,13.5 L20,7" })),
    lock: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 5.5, y: 10.5, width: 13, height: 9, rx: 1.6 }),
        React.createElement("path", { d: "M8,10.5 V7.8 A4,4 0 0,1 16,7.8 V10.5" })),
    unlock: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 5.5, y: 10.5, width: 13, height: 9, rx: 1.6 }),
        React.createElement("path", { d: "M8,10.5 V7.8 A4,4 0 0,1 15.7,6.3" })),
    plus: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,5 V19" }),
        React.createElement("path", { d: "M5,12 H19" })),
    download: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,4 V15" }),
        React.createElement("path", { d: "M7.5,11.5 L12,16 L16.5,11.5" }),
        React.createElement("path", { d: "M4.5,18.5 H19.5" })),
    upload: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,16 V5" }),
        React.createElement("path", { d: "M7.5,9.5 L12,5 L16.5,9.5" }),
        React.createElement("path", { d: "M4.5,18.5 H19.5" })),
    broom: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M16,4 L10,10" }),
        React.createElement("path", { d: "M10,10 L5,18 L15,18 Z" }),
        React.createElement("path", { d: "M9,18 L8.3,20.5" }),
        React.createElement("path", { d: "M12,18 L12,20.5" })),
    tree: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,21 V14" }),
        React.createElement("circle", { cx: 12, cy: 9, r: 6 })),
    package: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,8 L12,4 L20,8 L12,12 Z" }),
        React.createElement("path", { d: "M4,8 V16 L12,20 L20,16 V8" }),
        React.createElement("path", { d: "M12,12 V20" })),
    book: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,6.5 C9.7,5 6.3,4.5 3.8,5 V18 C6.3,17.5 9.7,18 12,19.5" }),
        React.createElement("path", { d: "M12,6.5 C14.3,5 17.7,4.5 20.2,5 V18 C17.7,17.5 14.3,18 12,19.5" }),
        React.createElement("path", { d: "M12,6.5 V19.5" })),
    puzzle: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 5.5, y: 5.5, width: 12, height: 12, rx: 1.6 }),
        React.createElement("circle", { cx: 11.5, cy: 5.5, r: 2 }),
        React.createElement("circle", { cx: 17.5, cy: 12, r: 2 })),
    sparkle: React.createElement("path", {
        d: "M12,2.5 C12.6,7.5 13,9.5 19,10.5 C13,11.5 12.6,13.5 12,18.5 C11.4,13.5 11,11.5 5,10.5 C11,9.5 11.4,7.5 12,2.5 Z",
        fill: "currentColor", stroke: "none",
    }),
    chart: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,17.5 L9.5,11 L13,14 L19.5,6" }),
        React.createElement("path", { d: "M14,6 H19.5 V11.5" })),
    coin: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8 }),
        React.createElement("circle", { cx: 12, cy: 12, r: 5 }),
        React.createElement("path", { d: "M12,9.3 V14.7" })),
    cash: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 3, y: 7, width: 18, height: 10, rx: 1.6 }),
        React.createElement("ellipse", { cx: 12, cy: 12, rx: 3, ry: 2.4 })),
    moneybag: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,4 C10.2,4 9,5.6 9,7.2 C7,7.8 4.8,10.5 4.8,14.3 C4.8,18.4 7.6,21 12,21 C16.4,21 19.2,18.4 19.2,14.3 C19.2,10.5 17,7.8 15,7.2 C15,5.6 13.8,4 12,4 Z" }),
        React.createElement("path", { d: "M9.3,7.4 H14.7" })),
    star: React.createElement("path", {
        d: "M12,3.5 L14.6,9.2 L20.8,9.9 L16.2,14 L17.5,20.2 L12,17 L6.5,20.2 L7.8,14 L3.2,9.9 L9.4,9.2 Z",
    }),
    users: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 9, cy: 8.5, r: 3 }),
        React.createElement("path", { d: "M4,20 C4,15.7 6.3,13.5 9,13.5 C11.7,13.5 14,15.7 14,20" }),
        React.createElement("circle", { cx: 17, cy: 9.5, r: 2.4 }),
        React.createElement("path", { d: "M14.3,20 C14.3,16.3 16,14.3 17.3,14.3 C18.9,14.3 20.5,16 20.8,19" })),
    // Added for the Referral Dashboard tab (see src/library/referral-dashboard.jsx) — a plain
    // gift box, same simple-stroke construction as every other glyph above.
    gift: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 4, y: 10, width: 16, height: 9.5, rx: 1.2 }),
        React.createElement("path", { d: "M4,10 H20 V13 H4 Z", fill: "currentColor", stroke: "none" }),
        React.createElement("path", { d: "M12,10 V19.5" }),
        React.createElement("path", { d: "M12,10 C12,6.5 9.5,5 8,5.3 C6.5,5.6 6.3,7.8 8,8.7 C9.2,9.3 11,9.8 12,10 Z" }),
        React.createElement("path", { d: "M12,10 C12,6.5 14.5,5 16,5.3 C17.5,5.6 17.7,7.8 16,8.7 C14.8,9.3 13,9.8 12,10 Z" })),
    // Solid variant of `star` above (filled rather than outlined) — for a "this is starred /
    // already earned" state where an outline read the same as its empty counterpart.
    starFilled: React.createElement("path", {
        d: "M12,3.5 L14.6,9.2 L20.8,9.9 L16.2,14 L17.5,20.2 L12,17 L6.5,20.2 L7.8,14 L3.2,9.9 L9.4,9.2 Z",
        fill: "currentColor", stroke: "none",
    }),
    // ---------- Author Inbox category emblems ----------
    // A small set added specifically so every "sealed letter" in the Inbox (see
    // src/library/inbox-and-living-universe.jsx) carries a proper engraved glyph instead of a
    // platform emoji — same 24x24 plain-stroke construction as every icon above, so they sit
    // comfortably in the same wax-seal roundel this app already uses for GrandLibraryAtmosphere.
    sealedLetter: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 3.3, y: 6.3, width: 17.4, height: 12, rx: 1.3 }),
        React.createElement("path", { d: "M3.8,7.2 L12,13.4 L20.2,7.2" }),
        React.createElement("circle", { cx: 12, cy: 13.6, r: 2.15, fill: "currentColor", stroke: "none" })),
    hourglass: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M6.5,4 H17.5" }),
        React.createElement("path", { d: "M6.5,20 H17.5" }),
        React.createElement("path", { d: "M7.3,4 C7.3,8.4 12,10.2 12,12 C12,10.2 16.7,8.4 16.7,4" }),
        React.createElement("path", { d: "M7.3,20 C7.3,15.6 12,13.8 12,12 C12,13.8 16.7,15.6 16.7,20" })),
    columns: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.3,8.3 L12,3.6 L20.7,8.3 Z" }),
        React.createElement("path", { d: "M4,20 H20" }),
        React.createElement("path", { d: "M6,9.2 V18.4" }),
        React.createElement("path", { d: "M10,9.2 V18.4" }),
        React.createElement("path", { d: "M14,9.2 V18.4" }),
        React.createElement("path", { d: "M18,9.2 V18.4" }),
        React.createElement("path", { d: "M4.5,18.4 H19.5" })),
    tag: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.5,3.5 H10.6 L20.5,13.4 L13.4,20.5 L3.5,10.6 Z" }),
        React.createElement("circle", { cx: 7.3, cy: 7.3, r: 1.3, fill: "currentColor", stroke: "none" })),
    medal: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M9.3,3.3 L6.8,10.6" }),
        React.createElement("path", { d: "M14.7,3.3 L17.2,10.6" }),
        React.createElement("circle", { cx: 12, cy: 14.6, r: 5.3 }),
        React.createElement("circle", { cx: 12, cy: 14.6, r: 2.1 })),
    horn: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4.3,16.3 C4.3,9.8 10,4.7 17.8,5.2" }),
        React.createElement("circle", { cx: 18.6, cy: 5.9, r: 2.1 }),
        React.createElement("path", { d: "M7.6,13.5 C8.7,12.7 10.1,12 11.7,11.5" }),
        React.createElement("path", { d: "M9.8,17.3 C7.5,17.6 5.7,17.2 4.3,16.3" })),
    search: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 10.3, cy: 10.3, r: 6.3 }),
        React.createElement("path", { d: "M15,15 L20.2,20.2" })),
    archiveBox: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.3,5.2 H20.7 V8.4 H3.3 Z" }),
        React.createElement("path", { d: "M4.5,8.4 V18 C4.5,18.66 5.04,19.2 5.7,19.2 H18.3 C18.96,19.2 19.5,18.66 19.5,18 V8.4" }),
        React.createElement("path", { d: "M9.8,12.4 H14.2" })),
    restore: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M9.5,5.3 L4.5,9.3 L9.5,13.3" }),
        React.createElement("path", { d: "M4.5,9.3 H14 C17.6,9.3 20.2,11.9 20.2,15.15 C20.2,18.4 17.6,20.5 14,20.5 H8.5" })),
    // ---------- Living Universe emblems ----------
    // Added so every badge, seal, and section mark on the Living Universe screen (see
    // src/library/living-universe-screen.jsx and src/library/inbox-and-living-universe.jsx)
    // carries a proper engraved glyph instead of a platform emoji — same 24x24 plain-stroke
    // construction as every icon above.
    trophy: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M7,4 H17 V8 C17,11 14.8,13 12,13 C9.2,13 7,11 7,8 Z" }),
        React.createElement("path", { d: "M7,5 H4.4 C4.4,8 6,9.6 7.6,9.8" }),
        React.createElement("path", { d: "M17,5 H19.6 C19.6,8 18,9.6 16.4,9.8" }),
        React.createElement("path", { d: "M12,13 V16.2" }),
        React.createElement("path", { d: "M9.6,16.2 H14.4 L15,20 H9 Z" }),
        React.createElement("path", { d: "M8.6,20 H15.4" })),
    castle: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4.5,20 V11 H7.2 V8.3 H5.8 V6 H8.6 V8.3 H7.2 V10.2 H10.2 V6.5 H13.8 V10.2 H16.8 V8.3 H15.4 V6 H18.2 V8.3 H16.8 V11 H19.5 V20 Z" }),
        React.createElement("path", { d: "M10,20 V15.5 H14 V20" })),
    flame: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,21 C8.7,21 6.3,18.6 6.3,15.3 C6.3,12.5 8.1,10.5 8.7,8.2 C9,9.5 9.8,10 10.4,9 C11.1,7.5 10.6,5.6 12,3.3 C12.8,6.3 14.6,7.3 15.1,10.1 C15.4,8.9 15.2,8 15.9,7.4 C17,9.3 17.7,11.7 17.7,14.2 C17.7,18 15.3,21 12,21 Z" }),
        React.createElement("path", { d: "M12,18.3 C10.6,18.3 9.7,17.2 9.7,15.8 C9.7,14.4 10.6,13.6 11,12.5 C11.3,13.6 12,13.8 12,12.9 C12.5,13.9 13,14.4 13,15.7 C13,17.1 13.3,18.3 12,18.3 Z", fill: "currentColor", stroke: "none" })),
    crown: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4.3,17 L4.3,9.8 L8.2,13 L12,6.8 L15.8,13 L19.7,9.8 V17 Z" }),
        React.createElement("path", { d: "M4.3,19.4 H19.7" })),
    map: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,7 L9,5 L15,7 L20,5 V18 L15,20 L9,18 L4,20 Z" }),
        React.createElement("path", { d: "M9,5 V18" }),
        React.createElement("path", { d: "M15,7 V20" })),
    target: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8.3 }),
        React.createElement("circle", { cx: 12, cy: 12, r: 5 }),
        React.createElement("circle", { cx: 12, cy: 12, r: 1.6, fill: "currentColor", stroke: "none" })),
    shield: React.createElement("path", { d: "M12,3.2 L19,6 V11.5 C19,16 16,19.5 12,21 C8,19.5 5,16 5,11.5 V6 Z" }),
    candle: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,3 C12.8,4.6 14,5.6 14,7.2 C14,8.35 13.1,9.05 12,9.05 C10.9,9.05 10,8.35 10,7.2 C10,5.6 11.2,4.6 12,3 Z", fill: "currentColor", stroke: "none" }),
        React.createElement("rect", { x: 9.4, y: 9.3, width: 5.2, height: 9.7, rx: 1 }),
        React.createElement("path", { d: "M7.8,19 H16.2" })),
    crossedSwords: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.6,3.6 L13.4,13.4" }),
        React.createElement("path", { d: "M3.6,3.6 V6.7" }),
        React.createElement("path", { d: "M3.6,3.6 H6.7" }),
        React.createElement("circle", { cx: 14.6, cy: 14.6, r: 1.1, fill: "currentColor", stroke: "none" }),
        React.createElement("path", { d: "M20.4,3.6 L10.6,13.4" }),
        React.createElement("path", { d: "M20.4,3.6 V6.7" }),
        React.createElement("path", { d: "M20.4,3.6 H17.3" }),
        React.createElement("circle", { cx: 9.4, cy: 14.6, r: 1.1, fill: "currentColor", stroke: "none" })),
    scroll: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M7,4.3 C5.5,4.3 4.3,5.5 4.3,7 C4.3,8.5 5.5,9.7 7,9.7 H17" }),
        React.createElement("path", { d: "M17,19.7 C18.5,19.7 19.7,18.5 19.7,17 C19.7,15.5 18.5,14.3 17,14.3 H7" }),
        React.createElement("path", { d: "M7,9.7 V14.3 H17" }),
        React.createElement("path", { d: "M7,4.3 V9.7" }),
        React.createElement("path", { d: "M17,14.3 V19.7" })),
    globe: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8.3 }),
        React.createElement("path", { d: "M3.7,12 H20.3" }),
        React.createElement("path", { d: "M12,3.7 C15,6.7 15,17.3 12,20.3 C9,17.3 9,6.7 12,3.7 Z" })),
    // Added for the Guild Notice Board (see src/guild/notice-board.jsx) — a plain drawing-pin/
    // thumbtack, same simple-stroke construction as every glyph above, for marking a real
    // announcement as pinned/important.
    pin: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M9.3,4.3 H14.7 L14.2,10 L17.5,13.3 H6.5 L9.8,10 Z" }),
        React.createElement("path", { d: "M12,13.3 V20.3" })),
    // Added for Settings entries across the app (Project Workspace sidebar, Account) — a plain
    // gear, same simple-stroke construction as every glyph above.
    gear: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 3.1 }),
        React.createElement("path", { d: "M12,3.6 V6.1 M12,17.9 V20.4 M20.4,12 H17.9 M6.1,12 H3.6 M17.7,6.3 L15.9,8.1 M8.1,15.9 L6.3,17.7 M17.7,17.7 L15.9,15.9 M8.1,8.1 L6.3,6.3" })),
    // The following four replace the last recurring emoji glyphs used as plain UI chrome across
    // the Grand Library topbar, book cards, and discussion threads (cart, notification bell,
    // discussion bubble, "view" eye) — same 24x24 plain-stroke construction as every icon above.
    cart: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.5,4.5 H5.7 L8,15.3 H17.5 L19.5,7.8 H6.6" }),
        React.createElement("circle", { cx: 9.3, cy: 19, r: 1.3, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 16.3, cy: 19, r: 1.3, fill: "currentColor", stroke: "none" })),
    bell: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M6,10.5 C6,6.9 8.7,4.5 12,4.5 C15.3,4.5 18,6.9 18,10.5 C18,15 19.5,16.3 19.5,16.3 H4.5 C4.5,16.3 6,15 6,10.5 Z" }),
        React.createElement("path", { d: "M10,19 C10.3,19.8 11,20.3 12,20.3 C13,20.3 13.7,19.8 14,19" })),
    chat: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,5.5 H20 V15.5 H9.5 L5.5,18.7 V15.5 H4 Z" })),
    eye: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M2.5,12 C4.8,7.6 8.1,5.4 12,5.4 C15.9,5.4 19.2,7.6 21.5,12 C19.2,16.4 15.9,18.6 12,18.6 C8.1,18.6 4.8,16.4 2.5,12 Z" }),
        React.createElement("circle", { cx: 12, cy: 12, r: 2.7 })),
    // Added for the Founder Guild emblem set (see guild/guild-hall.jsx's FOUNDER_GUILDS) — one
    // simple glyph per genre, same 24x24 plain-stroke construction as every icon above.
    heart: React.createElement("path", {
        d: "M12,20 C7,16.5 3.5,13.2 3.5,9.3 C3.5,6.6 5.6,4.5 8.2,4.5 C9.8,4.5 11.2,5.3 12,6.6 C12.8,5.3 14.2,4.5 15.8,4.5 C18.4,4.5 20.5,6.6 20.5,9.3 C20.5,13.2 17,16.5 12,20 Z",
    }),
    rocket: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,3.5 C15,5.5 16.5,9 16.5,12.5 C16.5,14.7 15.9,16.7 15,18.2 L12,20.5 L9,18.2 C8.1,16.7 7.5,14.7 7.5,12.5 C7.5,9 9,5.5 12,3.5 Z" }),
        React.createElement("circle", { cx: 12, cy: 11, r: 1.8 }),
        React.createElement("path", { d: "M8.5,16 L5.5,17.5 L6.3,14.2" }),
        React.createElement("path", { d: "M15.5,16 L18.5,17.5 L17.7,14.2" })),
    ghost: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M5.5,20 V11 C5.5,7.4 8.4,4.5 12,4.5 C15.6,4.5 18.5,7.4 18.5,11 V20 L16,18 L13.5,20 L11,18 L8.5,20 L6,18 Z" }),
        React.createElement("circle", { cx: 9.7, cy: 11.3, r: 1, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 14.3, cy: 11.3, r: 1, fill: "currentColor", stroke: "none" })),
    mask: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8.3 }),
        React.createElement("path", { d: "M8.5,10.3 C8.8,9.8 9.4,9.5 10,9.7" }),
        React.createElement("path", { d: "M15.5,10.3 C15.2,9.8 14.6,9.5 14,9.7" }),
        React.createElement("path", { d: "M8.3,14 C9.2,15.5 10.5,16.2 12,16.2 C13.5,16.2 14.8,15.5 15.7,14" })),
    // Added for the Story Health check registry (see writing/health-checks.jsx's HEALTH_CHECKS) —
    // a simple two-link chain, same construction as every glyph above.
    link: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M10.5,13.5 L13.5,10.5" }),
        React.createElement("path", { d: "M9,15 L6.5,17.5 C5.4,18.6 3.6,18.6 2.5,17.5 C1.4,16.4 1.4,14.6 2.5,13.5 L5,11" }),
        React.createElement("path", { d: "M15,9 L17.5,6.5 C18.6,5.4 20.4,5.4 21.5,6.5 C22.6,7.6 22.6,9.4 21.5,10.5 L19,13" })),
    // Added to replace the \u2601\uFE0F, \u26A0\uFE0F and \u2696\uFE0F emoji on the sync, conflict and judging controls.
    cloud: React.createElement("path", { d: "M7,18.5 C4.5,18.5 3,16.8 3,14.7 C3,12.7 4.5,11.2 6.4,11 C6.8,8.2 9,6 12,6 C14.9,6 17,8 17.5,10.6 C19.7,10.8 21,12.4 21,14.5 C21,16.8 19.3,18.5 17,18.5 Z" }),
    alert: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,4 L21,19.5 H3 Z" }),
        React.createElement("path", { d: "M12,10 V14.5" }),
        React.createElement("circle", { cx: 12, cy: 17, r: 0.9, fill: "currentColor", stroke: "none" })),
    scales: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,4 V19.5" }),
        React.createElement("path", { d: "M7.5,20 H16.5" }),
        React.createElement("path", { d: "M5,7.5 H19" }),
        React.createElement("path", { d: "M5,7.5 L2.8,13.2 C3.6,14.4 6.4,14.4 7.2,13.2 Z" }),
        React.createElement("path", { d: "M19,7.5 L16.8,13.2 C17.6,14.4 20.4,14.4 21.2,13.2 Z" })),
    // Added for the rank ladders and World Bible categories (they used to be emoji).
    feather: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M20,4 C14,4 8.5,8 7,14 L5.5,18.5 L10,17 C16,15.5 20,10 20,4 Z" }),
        React.createElement("path", { d: "M5,20 L13,12" })),
    pen: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,3 L17,13 L12,21 L7,13 Z" }),
        React.createElement("path", { d: "M12,13 V21" }),
        React.createElement("circle", { cx: 12, cy: 11, r: 1.2 })),
    key: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 8, cy: 15, r: 4 }),
        React.createElement("path", { d: "M11,12 L20,3 M16,7 L19,10 M14,9 L16,11" })),
    sprout: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,21 V11" }),
        React.createElement("path", { d: "M12,13.5 C12,9.5 9,7 5,7 C5,11 8,13.5 12,13.5 Z" }),
        React.createElement("path", { d: "M12,11 C12,7.5 14.5,5 19,5 C19,9 16,11 12,11 Z" })),
    torii: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3,7 C8,9 16,9 21,7" }),
        React.createElement("path", { d: "M5.5,9 V21 M18.5,9 V21 M7.5,12.5 H16.5 M12,9 V12.5" })),
    paw: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 6.5, cy: 11, r: 1.8 }),
        React.createElement("circle", { cx: 10, cy: 7, r: 1.8 }),
        React.createElement("circle", { cx: 14, cy: 7, r: 1.8 }),
        React.createElement("circle", { cx: 17.5, cy: 11, r: 1.8 }),
        React.createElement("path", { d: "M12,12.5 C9,12.5 6.5,15.5 7.5,18 C8.5,20 10.5,19 12,19 C13.5,19 15.5,20 16.5,18 C17.5,15.5 15,12.5 12,12.5 Z" })),
    user: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 8, r: 3.6 }),
        React.createElement("path", { d: "M5,20 C5,15.5 8,13.5 12,13.5 C16,13.5 19,15.5 19,20" })),
    calendar: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M6,5.5 H18 A2,2 0 0 1 20,7.5 V18 A2,2 0 0 1 18,20 H6 A2,2 0 0 1 4,18 V7.5 A2,2 0 0 1 6,5.5 Z" }),
        React.createElement("path", { d: "M4,10.5 H20 M8.5,3.5 V7.5 M15.5,3.5 V7.5" })),
    check: React.createElement("path", { d: "M5,12.5 L10,17.5 L19,7" }),
    close: React.createElement("path", { d: "M6,6 L18,18 M18,6 L6,18" }),
    minus: React.createElement("path", { d: "M6,12 H18" }),
    circle: React.createElement("circle", { cx: 12, cy: 12, r: 7 }),
    dot: React.createElement("circle", { cx: 12, cy: 12, r: 5, fill: "currentColor", stroke: "none" }),
    play: React.createElement("path", { d: "M8,5.5 L18,12 L8,18.5 Z", fill: "currentColor" }),
    arrowLeft: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M19,12 H5" }),
        React.createElement("path", { d: "M10.5,6.5 L5,12 L10.5,17.5" })),
    arrowRight: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M5,12 H19" }),
        React.createElement("path", { d: "M13.5,6.5 L19,12 L13.5,17.5" })),
};


export function InkIcon({ name, size = 18, color = 'currentColor', strokeWidth = 1.6, style }) {
    const glyph = ICON_PATHS[name];
    if (!glyph)
        return null;
    return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: color, strokeWidth, strokeLinecap: "round", strokeLinejoin: "round",
        style: Object.assign({ display: 'block', flexShrink: 0 }, style),
        "aria-hidden": "true",
    }, glyph);
}


// The app's main navigation: a slim bar pinned to the BOTTOM of the screen, where a thumb reaches.
// Five destinations, each with a real icon and a plain word, always in the same order:
// Home, Guild, Library, Universe, Inbox. The active one is gold with a lit bar above it.
//
// History: this used to be a sticky bar across the TOP with a "More" toggle that expanded a panel
// repeating the very same five destinations. That cost about a fifth of a phone screen, the lone
// triangle meant nothing to a first-time visitor, and the panel added nothing, so both are gone
// (Writer-Level gating of tabs was removed earlier - see git history). Guild Order is reached from
// inside the Guild Hall, not from this bar.
//
// It is rendered through a portal on document.body so an ancestor's transform or animation can never
// break `position: fixed`. Pages must leave room at the bottom (see HOME_NAV_CLEARANCE in
// home-screen.jsx). Modals and sheets use z-index 5000 and sit above it.
const HOME_NAV_TABS = [
    { key: 'home', label: 'Home', caption: 'Home' },
    { key: 'guild', label: 'Guild Hall', caption: 'Guild' },
    { key: 'library', label: 'Grand Library', caption: 'Library' },
    { key: 'universe', label: 'Living Universe', caption: 'Universe' },
    { key: 'inbox', label: 'Author Inbox', caption: 'Inbox' },
];

// A line icon followed by text, for buttons, banners and labels that used to start with an emoji.
// Renders inline so it can replace a "\u26A0\uFE0F some text" string in place, including inside
// ternaries and string concatenations: withIcon('alert', message). The icon takes the text's colour.
export function withIcon(name, text, size = 14) {
    return React.createElement(React.Fragment, null,
        React.createElement(InkIcon, { name, size, style: { display: 'inline-block', verticalAlign: '-2px', marginRight: 6, flexShrink: 0 } }),
        text);
}


// Renders whatever an `icon` field holds: an icon NAME from ICON_PATHS becomes an engraved line icon,
// a ready-made React element passes through untouched, and anything else (an old emoji saved on a
// device, or one a writer typed into an add-on category) still shows as plain text. That is what lets
// the rank and category tables move to icon names without breaking data that was saved earlier.
export function InkGlyph({ value, size = 16, color, style }) {
    if (React.isValidElement(value)) return value;
    if (typeof value === 'string' && ICON_PATHS[value]) return React.createElement(InkIcon, { name: value, size, color, style });
    if (value === undefined || value === null || value === '') return null;
    return React.createElement("span", { style: Object.assign({ fontSize: size, lineHeight: 1 }, style) }, value);
}


// Icon for each Platform Post type (the list itself lives in src/lib/platform-posts.js with an emoji
// per type; the app maps the post type to a line icon here instead of editing that file).
export const POST_TYPE_ICONS = {
    book_spotlight: 'book', worldbuilding_showcase: 'globe', guild_announcement: 'castle',
    writing_tip: 'feather', inkroot_update: 'scroll', event_announcement: 'trophy',
};


export function HomeNav({ activeTab, onSelect, inboxUnreadCount, universeNewCount, guildNewCount }) {
    const css = `
        .home-nav-bar {
          position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
          background: rgba(23,19,14,0.96); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
          border-top: 1px solid #3A3020; box-shadow: 0 -8px 24px rgba(0,0,0,0.45);
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }
        .home-nav-list { display: flex; align-items: stretch; justify-content: space-around; max-width: 640px; margin: 0 auto; padding: 0 6px; }
        .home-nav-tab {
          position: relative; flex: 1 1 0; min-width: 0; min-height: 60px; padding: 8px 2px 7px; border: none; background: transparent; cursor: pointer;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
          color: #8A8172; font-family: inherit; -webkit-tap-highlight-color: transparent;
          transition: color var(--ink-dur) var(--ink-ease);
        }
        .home-nav-tab:active { transform: scale(0.96); }
        .home-nav-tab.active { color: #E8C468; }
        .home-nav-tab.active::before {
          content: ''; position: absolute; top: -1px; left: 26%; right: 26%; height: 3px; border-radius: 0 0 3px 3px;
          background: linear-gradient(90deg, #A9812E, #F2D98A, #A9812E); box-shadow: 0 2px 10px rgba(232,196,104,0.55);
        }
        .home-nav-tab-icon { position: relative; display: flex; align-items: center; justify-content: center; }
        .home-nav-tab.active .home-nav-tab-icon { filter: drop-shadow(0 0 6px rgba(232,196,104,0.45)); }
        .home-nav-tab-caption { font-size: 12px; font-weight: 600; letter-spacing: 0.01em; line-height: 1.1; white-space: nowrap; }
        .home-nav-badge {
          position: absolute; top: -8px; right: -14px; font-size: 12px; font-weight: 700; color: #1A1610;
          background: #E8C468; border-radius: 999px; min-width: 18px; text-align: center; padding: 1px 4px;
          line-height: 16px; box-shadow: 0 0 6px rgba(232,196,104,0.5); pointer-events: none;
        }
    `;
    const bar = React.createElement("nav", { className: "home-nav-bar", "aria-label": "Main navigation" },
        React.createElement("style", null, css),
        React.createElement("div", { className: "home-nav-list" },
            HOME_NAV_TABS.map((t) => {
                const isActive = activeTab === t.key;
                // One badge per tab that has a count: the Inbox's unread letters, the Universe's new happenings, the Guild's new Fireside posts.
                const badge = t.key === 'inbox' ? inboxUnreadCount : t.key === 'universe' ? universeNewCount : t.key === 'guild' ? guildNewCount : 0;
                const badgeNoun = t.key === 'inbox' ? 'unread' : t.key === 'guild' ? 'new posts' : 'new happenings';
                return React.createElement("button", {
                    key: t.key, type: "button", onClick: () => onSelect(t.key), title: t.label,
                    "aria-label": t.label + (badge > 0 ? `, ${badge > 99 ? 'more than 99' : badge} ${badgeNoun}` : ''),
                    "aria-current": isActive ? 'page' : undefined,
                    className: "home-nav-tab" + (isActive ? ' active' : ''),
                },
                    React.createElement("span", { className: "home-nav-tab-icon" },
                        React.createElement(InkIcon, { name: t.key, size: 24, strokeWidth: isActive ? 1.9 : 1.6 }),
                        badge > 0 && React.createElement("span", { className: "home-nav-badge" }, badge > 99 ? '99+' : badge)),
                    React.createElement("span", { className: "home-nav-tab-caption" }, t.caption));
            })));
    return createPortal(bar, document.body);
}


// A small, fixed set of original entrance lines for the Home hero's welcome message — deterministic
// per calendar day (not random per render, so it doesn't flicker between two lines if the writer
// re-renders the page) via day-of-year, and separate from the time-of-day greeting so the two
// combine into something that doesn't repeat the same way every single day.
export const LIBRARY_ENTRANCE_LINES = [
    "The candles are lit, and the shelves are waiting.",
    "Somewhere on these shelves, your next chapter is already taking shape.",
    "The Hall is quiet tonight \u2014 a good night for writing.",
    "Dust drifts in the lamplight. The desk is exactly as you left it.",
    "Every tale in this Hall started the same way yours did: one page at a time.",
    "The ink is fresh and the parchment is patient.",
    "Somewhere above, a chandelier still burns for the writers who never stopped.",
];


export function timeOfDayGreeting() {
    const h = new Date().getHours();
    if (h < 5)
        return 'Burning the midnight oil';
    if (h < 12)
        return 'Good morning';
    if (h < 17)
        return 'Good afternoon';
    if (h < 21)
        return 'Good evening';
    return 'Good evening';
}


export function dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
}


// The Home welcome: a quiet header, not a framed scene. Greeting + one daily line on the left, the
// writer's avatar (their way into the Author's Hall) on the right, a hairline gilt rule beneath. The
// "Inkroot" wordmark and motto live on the Living Universe only, so they are not repeated here. The
// heavy wood frame, brass corner guards and stone-wall atmosphere that used to wrap this were dropped
// so the first thing on screen is the writer's own work, not decoration.
export function LibraryHero({ writerName, writerProfile, onOpenProfile, hasProjects }) {
    const now = useMemo(() => new Date(), []);
    const line = LIBRARY_ENTRANCE_LINES[dayOfYear(now) % LIBRARY_ENTRANCE_LINES.length];
    const greeting = timeOfDayGreeting();
    return React.createElement("div", { style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[14],
            padding: '2px 2px 18px', borderBottom: '1px solid rgba(232,196,104,0.16)',
        } },
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("h1", { style: { margin: 0, fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontStyle: 'italic', fontWeight: 600, lineHeight: 1.25, color: '#EFE7D2' } },
                greeting, writerName ? `, ${writerName}.` : '.'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#B8AC90', marginTop: 6, lineHeight: 1.5 } },
                hasProjects ? line : "The Hall stands ready for your first tale.")),
        React.createElement("button", { type: "button", onClick: onOpenProfile, title: "Author's Hall", "aria-label": "Open your Author's Hall", style: {
                width: 44, height: 44, borderRadius: '50%', flexShrink: 0, cursor: 'pointer', padding: 0,
                background: writerProfile && writerProfile.avatar ? `center/cover url(${writerProfile.avatar})` : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
                border: '2px solid #C89B3C', boxShadow: '0 0 0 2px #100E0A, 0 0 14px rgba(200,155,60,0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[17],
            } }, !(writerProfile && writerProfile.avatar) && React.createElement(InkIcon, { name: "users", size: 19, color: "#C89B3C" })));
}


// A short, original writing-craft line for "Today's Inspiration" — separate pool from the hero's
// entrance lines above (those greet the writer; these are meant to nudge the actual writing),
// picked the same deterministic day-of-year way so it holds steady for the whole day.
export const TODAYS_INSPIRATION_LINES = [
    "Write the sentence you're avoiding. It's usually the one the scene needs most.",
    "A character wants something, even if it's only a glass of water. What does yours want right now?",
    "Cut the sentence you're proudest of. See if the paragraph is stronger without it.",
    "Give a minor character one specific, unexplained detail today. Let the reader wonder.",
    "Change one scene from day to night, or night to day. Notice what else has to change with it.",
    "Write the ending first, badly, in three sentences. Now you know what you're walking toward.",
    "Let a character lie to another character today \u2014 and let the reader know before anyone else does.",
    "Describe a room using only what a character would notice while upset. Skip everything else.",
];


export function TodaysInspirationCard() {
    const line = useMemo(() => {
        const now = new Date();
        return TODAYS_INSPIRATION_LINES[dayOfYear(now) % TODAYS_INSPIRATION_LINES.length];
    }, []);
    return React.createElement("div", { style: {
            borderRadius: RADIUS_SCALE[14], padding: '22px 24px', marginBottom: 28,
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020',
            position: 'relative', overflow: 'hidden',
        } },
        React.createElement("div", { style: {
                position: 'absolute', top: -40, left: -40, width: 140, height: 140, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(200,155,60,0.09) 0%, rgba(200,155,60,0) 70%)',
            } }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 12, position: 'relative' } },
            React.createElement(InkIcon, { name: "candle", size: 17, color: "#C89B3C" }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#C89B3C' } }, "Today's Inspiration")),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontStyle: 'italic', color: '#EFE7D2', lineHeight: 1.55, position: 'relative' } }, line));
}


// One tile in the Quick Actions grid below Recent Activity — a small brass medallion (the same
// radial-gradient-circle-in-a-gold-ring vocabulary as the Writer Profile button and the wall
// sconces elsewhere on Home) holding the icon, mounted on a dark wood plaque, rather than a flat
// icon-over-label SaaS tile — so it reads as a fixture in the room, not a dashboard toolbar.
export function HomeQuickActionTile({ icon, label, onClick, disabled }) {
    return React.createElement("button", { onClick, disabled, className: "ghost-btn ink-brass-tile", style: {
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[10],
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[12], padding: '18px 10px 14px',
            cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, textAlign: 'center',
        } },
        React.createElement("span", { className: "ink-brass-medallion" }, icon),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#C9BE8D', fontWeight: 600 } }, label));
}


// One upcoming feature teaser in the "Inkroot News" section — every item here needs a shared
// backend Inkroot doesn't have yet (see ComingSoonNotice's use elsewhere for the same honesty
// about what is and isn't real today), so all of them carry the same gold "Coming Soon" pill
// rather than pretending any are closer than the others.
export function InkrootNewsCard({ icon, title, description }) {
    return React.createElement("div", { style: {
            display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start', padding: '16px 18px', borderRadius: RADIUS_SCALE[12],
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', marginBottom: 10,
        } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[18], flexShrink: 0, opacity: 0.85, marginTop: 1 } }, icon),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap', marginBottom: 4 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: '#EFE7D2' } }, title),
                React.createElement("span", { style: {
                        fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#C89B3C',
                        border: '1px dashed #4A3D22', borderRadius: RADIUS_SCALE[20], padding: '2px 8px',
                    } }, "Coming Soon")),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#A69C87', lineHeight: 1.5 } }, description)));
}
