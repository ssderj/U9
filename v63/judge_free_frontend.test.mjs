// Static front-end checks for judge-free guild events (giveaway / quiz / tournament).
// Run from the project root:  node --test judge_free_frontend.test.mjs
// No dependencies. Reads the source files and the SQL, so it catches drift between the two.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
// The event screens used to be one file (guild-events-panel.jsx); the checks below read them as one text.
const panel = ['ui', 'form', 'finance', 'card'].map((n) => read(`src/guild/guild-event-${n}.jsx`)).join('\n');
const lib = read('src/lib/guild-events.js');
const sql169 = read('supabase/history/169_migration_admin_judges_and_judge_free_events.sql');
const sql176 = read('supabase/history/176_migration_tournament_backend.sql');

const serverTypes = [...sql169.matchAll(/when '(\w+)' then '(giveaway_draw|quiz_score|tournament_bracket)'/g)].map((m) => m[1]).sort();

test('front-end judge-free list matches the types the server treats as judge-free', () => {
  const m = panel.match(/const judgeFree = \[([^\]]+)\]/);
  assert.ok(m, 'judgeFree list not found');
  const clientTypes = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(clientTypes, serverTypes);
});

// The app has no JS ready-flags any more: the only switch is the SQL function guild_event_type_backend_ready().
// This test requires the SQL side to be ready.
// Migration 176 is the last one that ships every type as ready; migration 188 deliberately pauses them again until the
// two-account checks pass (RESUME statement inside it). So this reads 176, not the latest definition.
test('migration 176 ships every judge-free type as ready', () => {
  const finalFn = sql176.slice(sql176.lastIndexOf('create or replace function guild_event_type_backend_ready'));
  for (const t of serverTypes) assert.match(finalFn, new RegExp(`when '${t}' then true`), `${t} not ready in SQL`);
});

test('judge-free save sends the neutral row the server accepts (metric none, weight 0)', () => {
  const m = panel.match(/judging: judgeFree\s*\?\s*\{([^}]*)\}/);
  assert.ok(m, 'judge-free payload not found');
  assert.match(m[1], /metric: 'none'/);
  assert.match(m[1], /weightPct: '0'/);
  // and the RPC mapping turns that into weight 0 bps
  assert.match(lib, /p_weight_bps: Math\.round\(Number\(weightPct\) \* 100\)/);
});

test('giveaway always saves a single 100% first place', () => {
  assert.match(panel, /eventType === 'giveaway' \? \[\{ place: '1', sharePct: '100' \}\]/);
});

test('judging controls are hidden for judge-free types and the split box is hidden for giveaways', () => {
  assert.match(panel, /fields\.eventType !== 'giveaway' && React\.createElement\("div", \{ style: S\.insetPanel/);
  const gated = panel.match(/!judgeFree && React\.createElement/g) || [];
  assert.ok(gated.length >= 3, 'metric/weight/help text should all be gated on !judgeFree');
});

test('judge-free types show "no judges" notes instead of the judge-panel text', () => {
  assert.match(panel, /Tournament winners come from the bracket, not from judges/);
  assert.match(panel, /Quiz winners are ranked by score[^']*There are no judges/);
  // the judge-panel explainer must be gated off for these types
  assert.match(panel, /!judgeFree && React\.createElement\("div", \{ style: S\.softHint \},\s*"Placements are computed/);
});

test('quiz/tournament host form allows places 1-3 only, with info shown; giveaway shows one-winner info', () => {
  assert.match(sql176, /not between 1 and 3/, 'server rule missing?');
  assert.match(panel, /\['reading_challenge', 'tournament'\]\.includes\(fields\.eventType\)\s*&&\s*placementSplitRows\.some\(\(r\) => r\.place && !\['1', '2', '3'\]/);
  assert.match(panel, /pays 1st, 2nd and 3rd place only/);
  assert.match(panel, /judgeFree && placementSplitRows\.length >= 3/);
  assert.match(panel, /A giveaway has one winner, who takes the whole prize/);
});

test('giveaway tie-break: migration 181, lib wrappers and the panel are all wired up', () => {
  const sql181 = read('supabase/history/181_migration_giveaway_tie_break.sql');
  const gp = read('src/guild/guild-event-giveaway-panel.jsx');
  for (const fn of ['decide_giveaway_tie', 'get_giveaway_tie_status', 'get_giveaway_tie_candidates', 'resolve_giveaway_ties']) {
    assert.match(sql181, new RegExp(`function ${fn}\\(`), `${fn} missing in SQL`);
    if (fn !== 'resolve_giveaway_ties') assert.match(lib + gp, new RegExp(fn), `${fn} not used by the app`); // the fallback is cron-only
  }
  assert.match(sql181, /interval '48 hours'/);
  assert.match(sql181, /cron\.schedule\('resolve-giveaway-ties'/);
  // the draw must not use the old "first to reach the count" rule any more
  assert.doesNotMatch(sql181.split('function draw_guild_giveaway')[1].split('$$;')[0], /updated_at asc/);
  // a tie makes the draw return nothing, so the wrapper must not demand exactly one row
  const wrapper = lib.slice(lib.indexOf('export async function drawGuildGiveaway'), lib.indexOf('export async function drawGuildGiveaway') + 300);
  assert.doesNotMatch(wrapper, /\.single\(\)/);
  assert.match(gp, /It\\u2019s a tie for the most entries/);
  assert.match(gp, /ConfirmDialog/);
  // the host form tells the host how ties are broken
  assert.match(gp, /your guild picks the winner from the tied people within 48 hours/);
});

test('official placements skip refunded entries (migration 189) and the detail page reads a cancelled event', () => {
  const sql189 = read('supabase/history/189_migration_official_placements_skip_refunded_entries.sql');
  // both the quiz ranking and the tournament podium must check the entry still stands
  assert.equal((sql189.match(/en\.status = 'success'/g) || []).length, 2);
  assert.match(lib, /approval_status\.eq\.cancelled,published_at\.not\.is\.null/);
  assert.match(read('src/guild/guild-event-detail-screen.jsx'), /fullEvent\.status === 'cancelled'/);
});
