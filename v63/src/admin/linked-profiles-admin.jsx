import React, { useEffect, useState } from 'react';
import { fetchMyLinkedProfiles, createLinkedProfile, switchToLinkedProfile } from '../lib/linked-profiles.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

const btnStyle = (primary) => ({
    background: primary ? '#2A2115' : 'none',
    border: '1px solid #3A3020',
    color: primary ? '#E8C468' : '#A6A6AD',
    borderRadius: RADIUS_SCALE[10],
    padding: '7px 14px',
    fontSize: TYPE_SCALE[12],
    cursor: 'pointer',
    fontWeight: primary ? 600 : 400,
});

const cardStyle = { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[11], padding: 14, marginBottom: 10 };
const sectionLabelStyle = { fontSize: TYPE_SCALE[12], color: '#8A8A92', margin: '18px 0 8px', letterSpacing: 0.4 };

// Entry point for the Linked Profiles screen. Admin-only for creating a profile (see
// linked-profiles-admin-only-spec.md — create-linked-profile re-checks is_platform_admin
// server-side), but SWITCHING is open to any account that has links, because a linked profile
// is a different account that does not inherit the main's admin flag: without this, the moment
// you switched into one there was no way back (or across) from the UI. Switching is re-checked
// server-side too (can_switch_to_linked_profile's own-account check), regardless of who can see
// this screen.
//
// Privacy posture, deliberately: when you are ON a linked profile, your main account's pen name
// is the one thing on this screen that links the pseudonym to a real identity, so it is shown
// masked ("Main account") and only revealed by an explicit tap, and it re-masks whenever this
// screen is left. Sibling profiles are listed by name because that is the only way to tell them
// apart when choosing one. None of this is visible to any other user; it is only ever drawn on
// the signed-in account's own screen.
export function LinkedProfilesAdmin({ onBack, isPlatformAdmin }) {
    const [loading, setLoading] = useState(true);
    const [linked, setLinked] = useState({ asMain: [], asSecondary: null, siblings: [] });
    const [error, setError] = useState(null);
    const [penName, setPenName] = useState('');
    const [creating, setCreating] = useState(false);
    const [switchingId, setSwitchingId] = useState(null);
    const [showMainName, setShowMainName] = useState(false);

    const load = () => {
        setLoading(true);
        fetchMyLinkedProfiles()
            .then((result) => { setLinked(result); setError(null); })
            .catch((e) => setError(e.message || 'Could not load linked profiles.'))
            .finally(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

    const handleCreate = async () => {
        if (!penName.trim()) return;
        setCreating(true);
        setError(null);
        try {
            await createLinkedProfile(penName.trim());
            setPenName('');
            load();
        } catch (e) {
            setError(e.message || 'Could not create the linked profile.');
        } finally {
            setCreating(false);
        }
    };

    const handleSwitch = async (targetId) => {
        setSwitchingId(targetId);
        setError(null);
        try {
            await switchToLinkedProfile(targetId);
            // A full reload rather than relying only on the auth-state listener: this is an
            // identity switch, not an ordinary re-sign-in, so every screen's in-memory state
            // (writer profile, projects, guild membership) should start clean under the new
            // session rather than carry anything over from the old one.
            window.location.reload();
        } catch (e) {
            setError(e.message || 'Could not switch profiles.');
            setSwitchingId(null);
        }
    };

    const busy = switchingId !== null;
    const onLinkedProfile = !!linked.asSecondary;
    const canCreate = !!isPlatformAdmin && !onLinkedProfile;
    const hasAnything = linked.asMain.length > 0 || linked.siblings.length > 0 || onLinkedProfile;

    const switchRow = (key, name, id, label) => React.createElement("div", {
        key,
        style: { ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[12] },
    },
        React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], color: '#EFE7D2', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
        React.createElement("button", {
            onClick: () => handleSwitch(id),
            disabled: busy,
            style: { ...btnStyle(false), flexShrink: 0, opacity: busy && switchingId !== id ? 0.5 : 1 },
        }, switchingId === id ? 'Switching\u2026' : label));

    return React.createElement("div", { style: { padding: '20px 16px', maxWidth: 560, margin: '0 auto' } },
        React.createElement("button", { onClick: onBack, style: { ...btnStyle(false), marginBottom: SPACE_SCALE[16] } }, "\u2190 Back"),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], color: '#EFE7D2', fontWeight: 600, marginBottom: 6 } }, "Linked Profiles"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#A6A6AD', marginBottom: SPACE_SCALE[16] } },
            "Pseudonymous secondary accounts. Restricted only from Player Guild functions \u2014 everything else works normally, and money always settles to the main account."),

        error && React.createElement("div", { role: "alert", style: { color: '#D98A8A', fontSize: TYPE_SCALE[12], marginBottom: SPACE_SCALE[12] } }, error),

        loading && React.createElement("div", { style: { color: '#A6A6AD', fontSize: TYPE_SCALE[12] } }, "Loading\u2026"),

        // Which profile you are on, and the way back. Shown only once the roster has loaded, so a
        // main account never briefly flashes a "linked profile" banner.
        !loading && onLinkedProfile && React.createElement("div", { style: { ...cardStyle, borderColor: '#4A3D22', marginBottom: 14 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#E8C468', fontWeight: 600, marginBottom: 10 } }, "You're on a linked profile"),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[12], flexWrap: 'wrap' } },
                React.createElement("div", { style: { minWidth: 0 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8A92', marginBottom: 2 } }, "Main account"),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
                        React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], color: '#EFE7D2', letterSpacing: showMainName ? 0 : 2 } },
                            showMainName ? linked.asSecondary.name : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022'),
                        React.createElement("button", {
                            onClick: () => setShowMainName((v) => !v),
                            "aria-pressed": showMainName,
                            "aria-label": showMainName ? 'Hide main account name' : 'Show main account name',
                            style: { ...btnStyle(false), padding: '3px 10px', fontSize: TYPE_SCALE[12] },
                        }, showMainName ? 'Hide' : 'Show'))),
                React.createElement("button", {
                    onClick: () => handleSwitch(linked.asSecondary.id),
                    disabled: busy,
                    style: btnStyle(true),
                }, switchingId === linked.asSecondary.id ? 'Switching\u2026' : 'Switch back to main'))),

        // A secondary's other profiles under the same main (migration 190's list_my_linked_profiles).
        !loading && linked.siblings.length > 0 && React.createElement("div", { style: sectionLabelStyle }, "OTHER LINKED PROFILES"),
        !loading && linked.siblings.map((p) => switchRow('sib-' + p.id, p.name, p.id, 'Switch to')),

        // A main account's own secondaries.
        !loading && linked.asMain.length > 0 && React.createElement("div", { style: sectionLabelStyle }, onLinkedProfile ? "LINKED PROFILES" : "YOUR LINKED PROFILES"),
        !loading && linked.asMain.map((p) => switchRow('sec-' + p.id, p.name, p.id, 'Switch to')),

        !loading && !hasAnything && React.createElement("div", { style: { color: '#A6A6AD', fontSize: TYPE_SCALE[12], marginBottom: 14 } }, "No linked profiles yet."),

        // Creating a profile is admin-only (create-linked-profile's own gate), and only from the
        // main account: a secondary would just be refused server-side, so it never sees the form.
        canCreate && React.createElement("div", { style: { marginTop: 20, paddingTop: 16, borderTop: '1px solid #2A2A30' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#EFE7D2', fontWeight: 600, marginBottom: 8 } }, "Create a linked profile"),
            React.createElement("input", {
                value: penName, onChange: (e) => setPenName(e.target.value),
                placeholder: "Pen name for the new profile",
                style: { width: '100%', boxSizing: 'border-box', background: '#141417', border: '1px solid #3A3020', color: '#EFE7D2', borderRadius: RADIUS_SCALE[10], padding: '8px 12px', fontSize: TYPE_SCALE[13], marginBottom: 8 },
            }),
            React.createElement("button", {
                onClick: handleCreate, disabled: creating || !penName.trim(), style: btnStyle(true),
            }, creating ? 'Creating\u2026' : 'Create linked profile'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8A92', marginTop: 8 } },
                `${linked.asMain.length}/25 linked profiles (admin-testing cap)`)));
}
