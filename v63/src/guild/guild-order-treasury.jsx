import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useState, useEffect, useRef } from 'react';
import { InkIcon, withIcon } from '../shell/ink-icon.jsx';
import { fetchGuildTreasuryLedger, fetchGuildTreasuryRole, fetchGuildTreasurySummary } from '../lib/guild-treasury.js';
import { fetchGuildAnthologies } from '../lib/guild-anthologies.js';
import { fetchProfileNames } from '../lib/profile.js';
import { GoMemberEarningsPanel } from './guild-member-earnings.jsx';
import { GoTreasuryAdminSection } from './guild-treasury-admin.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { GO_COMMISSIONS, GO_PERMISSIONS, GoLocked, goBtnStyle } from './guild-order-core.jsx';

// The original fake "Guild Coin" preview — kept as the honest fallback for whoever can't get a
// real treasury: only a signed-out or offline session now (see this file's HONESTY NOTE — a
// Founder Guild gets the real treasury too, same as a Player Guild).
// Nothing here moves real money; state.treasurySpent/treasuryLedger are this device's own
// local-only storage, same as every other GoState field.
function GoTreasuryTabSimulated({ guildReputation, playerRung, state, patchState }) {
    const balance = Math.max(0, Math.round((guildReputation || 0) / 8) - state.treasurySpent);
    const canSpend = playerRung >= GO_PERMISSIONS.spendTreasury;
    const commission = (c) => {
        if (balance < c.cost || !canSpend) return;
        patchState({ treasurySpent: state.treasurySpent + c.cost, treasuryLedger: [{ title: c.title, cost: c.cost, ts: Date.now() }, ...state.treasuryLedger] });
    };
    return React.createElement("div", null,
        React.createElement("style", null, GT_TREASURY_STYLES),
        React.createElement("div", { className: "gt-vault", style: { textAlign: 'center', marginBottom: 22 } },
            React.createElement("div", { className: "gt-strap" }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], letterSpacing: '0.16em', textTransform: 'uppercase', color: '#8A7752', marginBottom: 10 } }, "The Guild Coffer"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[34], fontWeight: 600, color: C.goldBright } }, balance.toLocaleString()),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 } }, 'Guild Coin'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 8, fontStyle: 'italic' } }, "Preview only \u2014 join or sign in to a real guild for the real treasury.")),
        !canSpend && React.createElement(GoLocked, { text: 'Only the Council and Guild Master may authorize spending from the treasury.' }),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: SPACE_SCALE[12], marginBottom: 26, opacity: canSpend ? 1 : 0.5 } },
            GO_COMMISSIONS.map((c) => React.createElement("div", { key: c.id, style: { background: `linear-gradient(165deg,${C.surfaceMuted},${C.surfaceDeep})`, border: '1px solid #332B1D', borderRadius: RADIUS_SCALE[11], padding: 15 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[18], marginBottom: 6 } }, c.icon),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], color: C.text, fontWeight: 600, marginBottom: 4 } }, c.title),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginBottom: 10, lineHeight: 1.5 } }, c.desc),
                React.createElement("button", { disabled: !canSpend || balance < c.cost, onClick: () => commission(c), style: { ...goBtnStyle(true), opacity: (!canSpend || balance < c.cost) ? 0.4 : 1, cursor: (!canSpend || balance < c.cost) ? 'default' : 'pointer' } }, `Commission \u2014 ${c.cost} coin`)))),
        state.treasuryLedger.length > 0 && React.createElement("div", null,
            React.createElement("div", { style: S.sectionLabel }, 'The ledger'),
            React.createElement("div", { className: "gt-ledger" }, state.treasuryLedger.slice(0, 8).map((l, i) => React.createElement("div", { key: i, className: "gt-ledger-row", style: { color: C.textSoft } },
                React.createElement("span", null, l.title), React.createElement("span", { style: { color: C.copper, fontFamily: "'Fraunces',Georgia,serif", fontWeight: 600 } }, `\u2212${l.cost}`))))));
}


// The real treasury. See supabase/history/33_migration_guild_treasury.sql /
// 44_migration_guild_treasury_roles_and_approvals.sql for where every number and role below
// comes from: guild_treasury_summary() is the single source for every balance shown here, and the
// ledger is a plain RLS-scoped select over guild_treasury_transactions — this component never
// computes, stores, or trusts a balance locally, and it never writes to the ledger directly.
// Contributing, authorizing/proposing a spend, approving a pending one, and assigning treasury
// roles are handled below by GoTreasuryAdminSection, each gated to the same role the backend
// itself requires (see that file's own header) — Guild Events and Anthology revenue splitting
// remain out of scope here, with their own dedicated screens.
// ---------- Guild Treasury — "The Guild Coffer" ----------
// An iron-bound strongbox and its ledger book, not a dashboard: the total sits behind a
// riveted plate, each balance reads as a drawer in the coffer, and every transaction is a line
// in a ruled ledger (credit in ink-green, debit in ink-oxblood) rather than a plain list row.
// Mobile-first: the drawer grid already collapses to one column below ~400px via its own
// auto-fit minmax, so no extra media query is needed there; the ledger itself never needs to
// reflow since it's always a single stacked column, the one layout that reads correctly whether
// it's an iPhone SE or a desktop window.
const GT_TREASURY_STYLES = `
    .gt-vault{position:relative;border-radius:${RADIUS_SCALE[16]}px;padding:26px 20px 22px;margin-bottom:6px;background:linear-gradient(165deg,#221C12 0%,#171310 100%);border:1px solid #3A2F1C;box-shadow:inset 0 0 0 1px rgba(232,196,104,0.08),0 10px 26px rgba(0,0,0,0.35);}
    .gt-vault::before,.gt-vault::after{content:'';position:absolute;top:10px;width:6px;height:6px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#B8935A,#5A4526);box-shadow:0 0 0 2px rgba(0,0,0,0.3);}
    .gt-vault::before{left:12px;}
    .gt-vault::after{right:12px;}
    .gt-strap{position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,transparent,rgba(184,147,90,0.55) 20%,rgba(184,147,90,0.55) 80%,transparent);}
    .gt-seal{display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:12px;letter-spacing:0.03em;padding:4px 11px;border-radius:100px;background:radial-gradient(circle at 30% 30%,#8F4A3A,#5E2E22);color:#F2DCC8;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.3);}
    .gt-ledger{background:#18140F;border:1px solid #2E2820;border-radius:${RADIUS_SCALE[12]}px;padding:4px 14px;}
    .gt-ledger-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:12px;padding:11px 0;border-bottom:1px solid #2A241C;}
    .gt-ledger-row:last-child{border-bottom:none;}
`;

const LEDGER_FETCH_LIMIT = 60;
const LEDGER_PAGE = 10;

function GoTreasuryTabReal({ remoteGuildId, isFounderView }) {
    // undefined = still loading; null = nothing to render (permission-denied or errored); an
    // object = loaded. Kept distinct from `[]`/`null` ledger states below so a real empty ledger
    // ("no transactions yet") never gets confused with "still fetching" or "couldn't fetch".
    const [summary, setSummary] = useState(undefined);
    const [ledger, setLedger] = useState(undefined);
    const [ledgerFailed, setLedgerFailed] = useState(false);
    const [ledgerShown, setLedgerShown] = useState(LEDGER_PAGE);
    const [ledgerNames, setLedgerNames] = useState({});
    const [anthologyTitles, setAnthologyTitles] = useState({});
    const [role, setRole] = useState(null);
    const [deniedText, setDeniedText] = useState(null);
    const [errorText, setErrorText] = useState(null);
    const [attempt, setAttempt] = useState(0);
    // True once this guild's summary has loaded at least once. A later refresh (after a
    // contribution/spend/approval) then keeps showing the last good numbers while it re-fetches,
    // instead of blanking the whole screen back to the skeleton and unmounting the actions section
    // (which used to wipe its "Contribution recorded" notice).
    const hasSummary = useRef(false);
    const hasLedger = useRef(false);

    // Only a different guild starts from a blank slate; a refresh (attempt) does not.
    useEffect(() => {
        hasSummary.current = false;
        hasLedger.current = false;
        setSummary(undefined);
        setLedger(undefined);
        setLedgerFailed(false);
        setLedgerShown(LEDGER_PAGE);
        setRole(null);
    }, [remoteGuildId]);

    useEffect(() => {
        let cancelled = false;
        setDeniedText(null);
        setErrorText(null);

        fetchGuildTreasurySummary(remoteGuildId).then((s) => {
            if (cancelled) return;
            // fetchGuildTreasurySummary itself returns null for signed-out/offline (see
            // guild-treasury.js) — the permission state, not a fetch failure.
            if (!s) { setDeniedText('Sign in and join this guild to open its treasury.'); return; }
            hasSummary.current = true;
            setSummary(s);
        }).catch((e) => {
            if (cancelled) return;
            // A failed refresh keeps the numbers already on screen.
            if (hasSummary.current) return;
            const message = (e && e.message) || '';
            // guild_treasury_summary() raises exactly this for a signed-in writer who isn't a
            // member of this guild — a permission state, not a technical failure, so it gets its
            // own message instead of the generic error/retry state below.
            if (/not a member/i.test(message)) setDeniedText('Only members of this guild can open its treasury.');
            else setErrorText(message || 'Could not open the treasury.');
        });

        fetchGuildTreasuryLedger(remoteGuildId, LEDGER_FETCH_LIMIT).then(async (rows) => {
            if (cancelled) return;
            hasLedger.current = true;
            setLedger(rows);
            setLedgerFailed(false);
            // Who made each entry, and which anthology a revenue-share row came from. Both are
            // nice-to-have: if either lookup fails the row just shows without that detail.
            const needsAnthologies = rows.some((t) => t.anthology_id);
            const [nameMap, anthologies] = await Promise.all([
                fetchProfileNames(rows.map((t) => t.created_by)).catch(() => ({})),
                needsAnthologies ? fetchGuildAnthologies(remoteGuildId).catch(() => []) : Promise.resolve([]),
            ]);
            if (cancelled) return;
            setLedgerNames(nameMap || {});
            const titles = {};
            anthologies.forEach((a) => { titles[a.id] = a.title; });
            setAnthologyTitles(titles);
        }).catch(() => {
            // Only show the failure when there's nothing already on screen to fall back on.
            if (!cancelled && !hasLedger.current) { setLedger([]); setLedgerFailed(true); }
        });
        fetchGuildTreasuryRole(remoteGuildId).then((r) => { if (!cancelled) setRole(r); }).catch(() => { });

        return () => { cancelled = true; };
    }, [remoteGuildId, attempt]);

    // ---- Permission state ----
    if (deniedText) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '38px 16px' } },
            React.createElement(InkIcon, { name: 'lock', size: 22, color: C.textMuted, style: { margin: '0 auto 12px' } }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.textSoft, maxWidth: 260, margin: '0 auto', lineHeight: 1.55 } }, deniedText));
    }

    // ---- Error state ----
    if (errorText) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '38px 16px' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.copperLight, marginBottom: 14, lineHeight: 1.55, maxWidth: 280, margin: '0 auto 14px' } }, errorText),
            React.createElement("button", { onClick: () => setAttempt((n) => n + 1), style: goBtnStyle(false) }, 'Try again'));
    }

    // ---- Loading state ----
    if (summary === undefined) {
        return React.createElement("div", null,
            React.createElement("style", null, `
                @keyframes goTreasuryPulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.85; } }
                .go-treasury-skel { animation: goTreasuryPulse 1.3s ease-in-out infinite; }
            `),
            React.createElement("div", { style: { textAlign: 'center', marginBottom: 24 } },
                React.createElement("div", { className: 'go-treasury-skel', style: { width: 150, height: 32, background: C.border, borderRadius: RADIUS_SCALE[6], margin: '0 auto 8px' } }),
                React.createElement("div", { className: 'go-treasury-skel', style: { width: 120, height: 9, background: C.border, borderRadius: RADIUS_SCALE[4], margin: '0 auto' } })),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: SPACE_SCALE[12], marginBottom: 24 } },
                [0, 1, 2, 3].map((i) => React.createElement("div", { key: i, className: 'go-treasury-skel', style: { height: 64, background: C.surface, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[11] } }))),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textMuted, textAlign: 'center', fontStyle: 'italic' } }, "Opening the treasury\u2026"));
    }

    // ---- Loaded ----
    // formatNaira() prints "Free" for a zero amount (fine for a book price, wrong for a treasury
    // balance sitting at ₦0), so the treasury uses its own formatter that always prints a real amount.
    const nairaText = (n) => `\u20a6${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
    const dateText = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } };

    const roleLabel = { leader: 'Guild Leader', treasurer: 'Treasurer', officer: 'Officer', member: 'Member' }[role] || null;

    // Headline number. A Player Guild leads with what it can actually spend (guild-owned funds
    // minus what's already spent or reserved). A Founder Guild never has a spendable treasury
    // (see 122_migration_founder_guild_no_treasury_or_hosting.sql — guild-owned/available are a
    // permanent 0), so its headline is what's held in trust for members instead.
    const heroValue = isFounderView ? summary.memberEarningsNaira : summary.availableNaira;
    const heroLabel = isFounderView ? 'Held in trust for members' : 'Available to spend';
    // Member earnings are money that passes through the guild but belongs to individual writers,
    // so on a Player Guild they're a quiet note under the headline rather than part of it.
    const detailBits = [];
    if (!isFounderView) detailBits.push(`Guild-owned ${nairaText(summary.guildOwnedNaira)}`);
    if (summary.pendingNaira > 0) detailBits.push(`Settling ${nairaText(summary.pendingNaira)}`);

    // Friendly label for a ledger row's `kind` — anthology_share/event_revenue rows can already
    // exist server-side (see 37/48_migration_*.sql); this just names them plainly rather than
    // showing a raw enum value.
    const kindLabel = (t) => {
        if (t.title) return t.title;
        switch (t.kind) {
            case 'contribution': return 'Member contribution';
            case 'spend': return 'Guild spend';
            case 'anthology_share': return t.anthology_id && anthologyTitles[t.anthology_id] ? `Anthology revenue \u2014 ${anthologyTitles[t.anthology_id]}` : 'Anthology revenue share';
            case 'event_revenue': return 'Guild event revenue';
            case 'release_to_member': return 'Earnings released';
            default: return t.kind;
        }
    };

    // The guild ledger is the guild's own money. A member's personal earnings rows (bucket
    // 'member', only ever the caller's own) live in "Your drawer in the coffer" below instead.
    const guildRows = (ledger || []).filter((t) => t.bucket !== 'member');
    const visibleRows = guildRows.slice(0, ledgerShown);

    const ledgerBlock = React.createElement("div", { style: { marginTop: 22 } },
        React.createElement("div", { style: S.sectionLabel }, 'The ledger'),
        ledgerFailed
            ? React.createElement("div", { style: { textAlign: 'center', padding: '20px 10px' } },
                React.createElement("div", { style: { ...S.noteItalic, marginBottom: 12 } }, "Couldn't load the ledger."),
                React.createElement("button", { onClick: () => setAttempt((n) => n + 1), style: goBtnStyle(false) }, 'Try again'))
            : (ledger !== undefined && guildRows.length === 0)
                ? React.createElement("div", { style: { textAlign: 'center', padding: '26px 10px' } },
                    React.createElement(InkIcon, { name: 'coin', size: 18, color: C.textMuted, style: { margin: '0 auto 8px', opacity: 0.7 } }),
                    React.createElement("div", { style: S.noteItalic }, isFounderView ? "Nothing in the ledger yet." : "The ledger is empty \u2014 no contributions or spends have been recorded yet."))
                : ledger === undefined
                    ? React.createElement("div", { style: S.emptyNote }, "Loading the ledger\u2026")
                    : React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "gt-ledger" }, visibleRows.map((t) => {
                            const by = t.created_by && ledgerNames[t.created_by];
                            const meta = [dateText(t.created_at), by].filter(Boolean).join(' \u00b7 ');
                            return React.createElement("div", { key: t.id, className: "gt-ledger-row", style: { color: C.textSoft } },
                                React.createElement("div", { style: S.fill },
                                    React.createElement("div", null, kindLabel(t) + (t.status === 'pending' ? ' \u2014 pending' : '')),
                                    meta && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 2 } }, meta)),
                                React.createElement("span", { style: { color: t.direction === 'credit' ? '#7FB2A0' : C.copper, flexShrink: 0, fontWeight: 600, fontFamily: "'Fraunces', Georgia, serif" } }, `${t.direction === 'credit' ? '+' : '\u2212'}${nairaText(t.amountNaira)}`));
                        })),
                        guildRows.length > ledgerShown && React.createElement("div", { style: { textAlign: 'center', marginTop: 12 } },
                            React.createElement("button", { onClick: () => setLedgerShown((n) => n + LEDGER_PAGE), style: goBtnStyle(false) }, 'Show more'))));

    return React.createElement("div", null,
        React.createElement("style", null, GT_TREASURY_STYLES),
        React.createElement("div", { className: "gt-vault", style: { textAlign: 'center', marginBottom: 24 } },
            React.createElement("div", { className: "gt-strap" }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], letterSpacing: '0.16em', textTransform: 'uppercase', color: '#8A7752', marginBottom: 10 } }, "The Guild Coffer"),
            React.createElement(InkIcon, { name: 'moneybag', size: 22, color: C.goldBright, style: { margin: '0 auto 10px' } }),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontWeight: 600, color: C.goldBright, wordBreak: 'break-word' } }, nairaText(heroValue)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 } }, heroLabel),
            detailBits.length > 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textSoft, marginTop: 8 } }, detailBits.join(' \u00b7 ')),
            !isFounderView && summary.memberEarningsNaira > 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 6, fontStyle: 'italic' } }, `${nairaText(summary.memberEarningsNaira)} more is held in trust for members and isn't guild money.`),
            roleLabel && React.createElement("div", { className: "gt-seal", style: { marginTop: 12 } }, withIcon('crossedSwords', roleLabel, 13))),

        // Player Guild: Contribute / Authorize a spend sit right under the headline, then any spend
        // requests waiting on approval, and only then the ledger (passed in as `children`, which the
        // actions section renders between its pending requests and its history/role panels).
        // Treasury actions — Contribute (any member), Authorize/Propose a spend and approve
        // pending ones (Leader/Treasurer/Officer only), and role management (Leader only). Every
        // control here operates on the guild-owned bucket above, never on any member's own held
        // earnings — see GoTreasuryAdminSection's own header comment.
        // A Founder Guild has no treasury to contribute to or spend from (see
        // 122_migration_founder_guild_no_treasury_or_hosting.sql) — contribute_to_guild_treasury/
        // spend_from_guild_treasury/propose_guild_treasury_spend all refuse server-side for one, so
        // it gets the ledger plus a short info card instead of a dead-end button.
        isFounderView
            ? React.createElement(React.Fragment, null,
                ledgerBlock,
                React.createElement("div", { style: { marginTop: 22, padding: '14px 16px', borderRadius: RADIUS_SCALE[11], background: C.surface, border: `1px solid ${C.border}`, fontSize: TYPE_SCALE[11.5], color: C.textSoft, lineHeight: 1.55, textAlign: 'center' } },
                    "A Founder Guild has no treasury of its own \u2014 Inkroot funds any official cash-prize event for it directly, and members' own earnings still show below."))
            : React.createElement(GoTreasuryAdminSection, {
                guildId: remoteGuildId, role, availableNaira: summary.availableNaira,
                refreshSummary: () => setAttempt((n) => n + 1), isFounderView,
            }, ledgerBlock),

        // My Earnings — this signed-in member's own held-in-trust earnings in this one guild
        // (available/pending/lifetime, earnings by project, and real withdrawal history), plus
        // the Withdraw action against them. Entirely separate data from the guild-wide summary
        // above: GoMemberEarningsPanel only ever reads/moves this member's own 'member'-bucket
        // rows (see its own header comment for why that's enforced server-side, not just by
        // props), so there's no overlap with the guild-owned funds shown higher on this screen.
        React.createElement(GoMemberEarningsPanel, { guildId: remoteGuildId }));
}


// remoteGuildId is a real player_guilds.id for both guild types now — a Player Guild's own real
// row, or a Founder Guild's fixed backendGuildId (see FOUNDER_GUILDS in guild-hall.jsx and
// supabase/history/69_migration_founder_guild_parity.sql), set by home-screen.jsx's
// guildOrderBackendId. null only for a signed-out or offline session, which is exactly when the
// simulated preview below should show instead. isOwner only affects which controls GoTreasuryTabReal renders; every
// financial action is still re-authorized server-side regardless of what this prop says.
export function GoTreasuryTab({ guildReputation, playerRung, state, patchState, remoteGuildId, isFounderView }) {
    if (remoteGuildId) {
        return React.createElement(GoTreasuryTabReal, { remoteGuildId, isFounderView });
    }
    return React.createElement(GoTreasuryTabSimulated, { guildReputation, playerRung, state, patchState });
}
