import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fmtDuration, ownerSummary } from '../agent/relay/lib/console.mjs';
import { ctx } from '../agent/relay/lib/runtime.mjs';
import { addCosts, quotaChange, stepShares } from '../scripts/scorecard/costs.mjs';
import { analyzeTopic, latency } from '../scripts/scorecard/measures.mjs';
import { readEvents, readSession } from '../scripts/scorecard/records.mjs';
import { assistant, at, readFake, T0, tmp, topicEvents, writeLines } from './scorecard-fixture.mjs';

const analyzed = (events = topicEvents()) => addCosts(analyzeTopic('t', events), { readSessionFile: readFake });
const slice = (r, id) => r.slices.find((s) => s.id === id);

test('events: an incomplete last line is ignored, an unreadable line in the middle is counted', () => {
  const file = path.join(tmp(), 'events.jsonl');
  writeLines(file, [{ t: at(0), type: 'run_start' }, '{broken', { t: at(1), type: 'run_stop' }], '{"t":"2026-11-01T1');
  const r = readEvents(file);
  assert.equal(r.events.length, 2);
  assert.equal(r.unreadable, 1);
  assert.equal(r.partialTail, true);
});

test('sessions: replies, cache warming and compactions count, by model, up to the cutoff; bad lines are reported', () => {
  const file = path.join(tmp(), 's.jsonl');
  writeLines(file, [
    { type: 'model_change', timestamp: at(0), provider: 'anthropic', modelId: 'm1' },
    assistant(1, 1.5),
    { type: 'usage', kind: 'cache_warm', timestamp: at(2), model: 'm1', provider: 'anthropic', usage: { cacheRead: 9, cost: { total: 0.25 } } },
    { type: 'compaction', timestamp: at(3), usage: { input: 5, output: 1, cost: { total: 0.5 } } },
    '{"type":"message","message":{"usage":',
    '{"type":"message","id":"cut short',
    '{"type":"usage","usage":{"cost":}}',
    '{"type":"message","message":}',
    ` ${JSON.stringify(assistant(4, 0.75))} `,
    assistant(4, 2, 'm2', 'openai'),
    { ...assistant(4, 7), timestamp: 'never' },
    assistant(10, 100),
  ], JSON.stringify(assistant(4, 1000)).slice(0, 30));
  const r = readSession(file, T0 + 5 * 60000);
  assert.equal(r.total.costUsd, 5, 'the call after the cutoff, the bad lines and the incomplete tail are not counted');
  assert.equal(r.total.cacheWarmUsd, 0.25);
  assert.equal(r.total.compactionUsd, 0.5);
  assert.equal(r.unreadable, 5, 'four broken complete lines, whatever they held, and an entry without a valid time');
  assert.deepEqual(Object.keys(r.byModel).sort(), ['anthropic/m1', 'openai/m2']);
  assert.equal(r.byModel['anthropic/m1'].costUsd, 3, 'a valid line with spaces around it counts');
  assert.equal(readSession(null).missing, 'no session recorded');
  assert.equal(readSession(path.join(tmp(), 'gone.jsonl')).missing, 'session file gone');
});

test('reviews: loops, first review, distinct returning findings, a reordered replay counted once', () => {
  const s1 = slice(analyzed(), 'S1');
  assert.equal(s1.loops, 2);
  assert.equal(s1.firstReview, 'changes-required');
  assert.deepEqual([...s1.returning], ['R1'], 'R2 did not return; R3 was new at the re-review');
  assert.equal(s1.escalations, 1);
  assert.equal(s1.ambiguous, 0);
});

test('replays: a different result without a new send is kept and marked ambiguous; FINAL replays count once', () => {
  const events = topicEvents();
  const i = events.findIndex((e) => e.type === 'step_result' && e.purpose === 'rereview1' && e.slice === 'S1' && e.blocking[0] === 'R1' && e.role === 'reviewer') + 1;
  events[i] = { ...events[i], verdict: 'accept', blocking: [] };
  const r = analyzed(events);
  assert.equal(slice(r, 'S1').ambiguous, 1);
  assert.equal(slice(r, 'S1').loops, 2, 'the accepting duplicate is not a loop');
  assert.deepEqual(r.special.get('FINAL').verifications, [null]);
});

test('decisions follow the question that preceded them; unknown choices and revisits stay unknown', () => {
  const r = analyzed();
  const s1 = slice(r, 'S1');
  assert.equal(s1.ownerDecisions, 1);
  assert.equal(s1.councilDecisions, 1);
  assert.deepEqual(s1.revisits, { known: 1, proposed: 1, owner: 1, council: 0 }, 'the second brief has no revisits field: unknown');
  assert.equal(r.slices.some((s) => s.id === 'Some title from an old relay'), false, 'a title in an old event makes no slice');
  const events = topicEvents().map((e) => (e.type === 'owner_decision' ? { ...e, chosen: null } : e));
  assert.equal(slice(analyzed(events), 'S1').chosenKnown, 0);
});

test('latency: from the last start; a set-aside before it is not subtracted; earlier attempts keep their cost', () => {
  const r = analyzed();
  const s2 = slice(r, 'S2');
  const time = (type, id, n = 0) => Date.parse(topicEvents().filter((e) => e.type === type && e.slice === id)[n].t);
  assert.equal(latency(s2), time('slice_done', 'S2') - time('slice_start', 'S2', 1));
  assert.ok(latency(s2) > 0);
  assert.equal(s2.supersededUsd, 2, 'the acceptance session of the first attempt');
  assert.equal(s2.cost.costUsd, 3);
  const inside = topicEvents();
  const k = inside.findIndex((e) => e.type === 'slice_start' && e.slice === 'S2' && e.title === 'Two' && !e.needs);
  const [restart] = inside.splice(k, 1);
  inside.splice(inside.findIndex((e) => e.type === 'slice_set_aside'), 0, restart);
  inside.forEach((e, n) => { e.t = at(n); }); // times in the new order
  const t2 = (type) => Date.parse(inside.find((e) => e.type === type && e.slice === 'S2' && (type !== 'slice_start' || !e.needs)).t);
  const s2b = slice(analyzed(inside), 'S2');
  assert.equal(latency(s2b), t2('slice_done') - t2('slice_start') - (t2('slice_resumed') - t2('slice_set_aside')), 'a set-aside inside it is');
});

test('partial cost: a result without its session, a gone session file, history that starts mid-slice', () => {
  const r = analyzed();
  assert.deepEqual(slice(r, 'S2').partial, ['implementer: result without its session on record']);
  assert.deepEqual(slice(r, 'S3').partial, ['implementer: session file gone']);
  const replaced = topicEvents().map((e) => (e.slice === 'S1' && e.type === 'step_sent' && e.purpose === 'repair1' ? { ...e, agent: 'implementer-2' } : e));
  replaced.find((e) => e.type === 'agent_start' && e.slice === 'S1' && e.role === 'implementer').agent = 'implementer-1';
  assert.deepEqual(slice(analyzed(replaced), 'S1').partial, ['implementer: result without its session on record'], 'a later worker of the role without its start');
  const late = topicEvents().slice(14); // from S1's reviewer on: no start of S1 on record
  const s1 = slice(analyzed(late), 'S1');
  assert.ok(s1.partial.includes('history starts mid-slice'));
  assert.equal(s1.firstReview, null, 'the first review is unknown without the start');
  const skip = topicEvents().filter((e) => !(e.slice === 'S1' && ['review'].includes(e.purpose)));
  assert.equal(slice(analyzed(skip), 'S1').firstReview, null, 'a re-review is not the first review');
});

test('step shares: review cycles after the first rejection, nudged steps', () => {
  assert.deepEqual(stepShares(slice(analyzed(), 'S1')), { reviewCycleUsd: 3 + 1 + 4 + 1, nudgedUsd: 5 });
});

test('owner wait agrees with the relay console; waits are split by kind', () => {
  const dir = tmp();
  writeLines(path.join(dir, 'events.jsonl'), topicEvents());
  ctx.relayDir = dir;
  const r = analyzed();
  assert.match(ownerSummary(), new RegExp(`${fmtDuration(r.topic.waitedMs)} waiting`));
  assert.deepEqual(slice(r, 'S1').waitedByStatus, { 'needs-decision': 3600000 });
  assert.equal(r.topic.waitsByStatus.blocked, 1);
});

test('quota change: positive steps within a reset window only, by day', () => {
  const r = (pct, resets, day = 1) => ({ at: Date.UTC(2026, 10, day), pct, resets });
  const q = quotaChange([r(10, 1), r(12, 1), r(15, 1), r(71, 1, 2), r(0, 2, 2), r(4, 2, 2), r(3, 2, 3), r(5, 2, 3)]);
  assert.equal(q.points, 61 + 4 + 2);
  assert.equal(q.windows, 3);
  assert.deepEqual(q.byDay, { '2026-11-01': 5, '2026-11-02': 60, '2026-11-03': 2 });
});
