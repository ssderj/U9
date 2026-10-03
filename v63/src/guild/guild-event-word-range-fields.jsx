import { C } from './guild-theme.js';
import React from 'react';
import { evInputStyle } from './guild-event-ui.jsx';
import { SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// ---------------------------------------------------------------------------------------------
// Backend support landed in 166_migration_guild_event_writing_word_range.sql: guild_events has
// min_word_count/max_word_count columns, create_guild_event_draft/update_guild_event_draft
// accept + validate them, and submit_guild_event_submission() rejects an out-of-range word
// count server-side. lib/guild-events.js passes them through as minWordCount/maxWordCount.
// ---------------------------------------------------------------------------------------------
const wrLabelStyle = { fontSize: TYPE_SCALE[10.5], color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };

// Returns an error string, or null if the range is fine.
export function validateWordRange(minWordCount, maxWordCount) {
    const hasMin = minWordCount !== '' && minWordCount != null;
    const hasMax = maxWordCount !== '' && maxWordCount != null;
    if (hasMin && (!Number.isInteger(Number(minWordCount)) || Number(minWordCount) < 1)) return 'Minimum word count must be a whole number of at least 1.';
    if (hasMax && (!Number.isInteger(Number(maxWordCount)) || Number(maxWordCount) < 1)) return 'Maximum word count must be a whole number of at least 1.';
    if (hasMin && hasMax && Number(minWordCount) > Number(maxWordCount)) return 'Minimum word count can\u2019t be higher than the maximum.';
    return null;
}

export function WordRangeFields({ minWordCount, maxWordCount, onChange, locked }) {
    const disabled = !!locked;
    return React.createElement("div", { style: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 } },
        React.createElement("div", { style: { ...wrLabelStyle, marginBottom: 8 } }, 'Word range for entries (optional)'),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8], marginBottom: 8 } },
            React.createElement("div", null,
                React.createElement("label", { style: wrLabelStyle }, 'Minimum words'),
                React.createElement("input", { type: "number", min: "1", value: minWordCount, disabled, placeholder: 'No minimum', onChange: (e) => onChange('minWordCount', e.target.value), style: { ...evInputStyle, opacity: disabled ? 0.5 : 1 } })),
            React.createElement("div", null,
                React.createElement("label", { style: wrLabelStyle }, 'Maximum words'),
                React.createElement("input", { type: "number", min: "1", value: maxWordCount, disabled, placeholder: 'No maximum', onChange: (e) => onChange('maxWordCount', e.target.value), style: { ...evInputStyle, opacity: disabled ? 0.5 : 1 } }))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.neutralSoft, fontStyle: 'italic' } },
            'Entries outside this range are rejected when submitted. Locked once the event opens for entries.'));
}
