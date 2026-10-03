import React, { useEffect, useState } from 'react';
import { evBtnStyle, evInputStyle } from '../guild/guild-event-ui.jsx';
import { fetchRefundsOwed, markEntryRefunded } from '../lib/guild-events.js';
import { formatNairaBalance } from '../lib/payments.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Refunds owed on cancelled paid events (migration 186). Cancelling an event returns the PRIZE, but an
// entrant's entry fee is never moved by the app: Inkroot sends it by hand from Paystack's dashboard. This
// screen is only the to-do list -- who paid, how much, for which event, and the Paystack reference to search
// for -- plus a button to record "I sent it". It moves no money and never calls Paystack. Marking an entry
// refunded is a record-keeping step: do it AFTER the real refund. A refund processed through Paystack also
// clears itself (Paystack's refund.processed webhook flips the entry to 'refunded'), so an entry can vanish
// from here without anyone tapping anything. Covers every cancel path, guild and official events alike,
// because the server marks entries owed whenever an event becomes cancelled.
const box = { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 12, marginBottom: 16 };

function formatDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return ''; }
}

function RefundRow({ row, onChanged }) {
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const done = async () => {
        setBusy(true);
        setError(null);
        try { await markEntryRefunded(row.entryId, note.trim()); onChanged(); }
        catch (e) { setError(e.message || 'That did not go through.'); }
        finally { setBusy(false); }
    };

    return React.createElement("div", { style: { borderTop: '1px solid #2A2A30', paddingTop: 10, marginTop: 10 } },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#EFE7D2', fontWeight: 600 } }, row.entrantName),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#EFE7D2', fontWeight: 600 } }, formatNairaBalance(row.amountNaira))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D9D2BE', marginTop: 2 } },
            row.eventTitle + (row.isOfficial ? ' \u00b7 Official' : '')),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#8A8A92', marginTop: 2, wordBreak: 'break-all' } },
            'Paystack ref: ' + row.paystackReference + ' \u00b7 owed since ' + formatDate(row.owedAt)),
        row.cancellationReason && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#8A8A92', marginTop: 2 } }, 'Cancelled: ' + row.cancellationReason),
        React.createElement("input", { value: note, onChange: (e) => setNote(e.target.value), maxLength: 500, placeholder: 'Note (optional, e.g. Paystack refund reference)', style: { ...evInputStyle, marginTop: 8, marginBottom: 6 } }),
        React.createElement("button", { disabled: busy, onClick: done, style: { ...evBtnStyle(true), opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'I sent this refund on Paystack'),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 6 } }, error));
}

export function RefundsOwedAdmin() {
    const [open, setOpen] = useState(false);
    const [rows, setRows] = useState(null);
    const [loadError, setLoadError] = useState(null);

    const load = () => {
        setLoadError(null);
        return fetchRefundsOwed().then(setRows).catch((e) => { setRows([]); setLoadError(e.message || 'Could not load the list.'); });
    };
    useEffect(() => { if (open) load(); }, [open]);

    const total = (rows || []).reduce((sum, r) => sum + r.amountNaira, 0);

    return React.createElement("div", { style: box },
        React.createElement("button", { onClick: () => setOpen((v) => !v), style: { display: 'flex', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', color: '#EFE7D2', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer', padding: 0 } },
            React.createElement("span", null, 'Refunds owed' + (rows && rows.length ? ` (${rows.length})` : '')),
            React.createElement("span", { style: { color: '#8A8A92' } }, open ? '\u2212' : '+')),
        open && React.createElement("div", { style: { marginTop: 10 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#84848C', fontStyle: 'italic', marginBottom: 6 } },
                'Entry fees from cancelled events. Send each refund from Paystack first, then mark it here. The app never moves this money.'),
            rows === null && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#84848C', textAlign: 'center' } }, 'Opening\u2026'),
            loadError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5] } }, loadError),
            rows && rows.length === 0 && !loadError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#84848C', textAlign: 'center' } }, 'No refunds owed.'),
            rows && rows.length > 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D9D2BE' } }, `${rows.length} owed \u00b7 ${formatNairaBalance(total)} in total`),
            rows && rows.map((r) => React.createElement(RefundRow, { key: r.entryId, row: r, onChanged: load }))));
}
