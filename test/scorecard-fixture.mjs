// Records for the scorecard tests (no tests here). The topic: S1 rejected twice (R1 returns, R2 does not, R3 is
// new at the re-review), a replayed result written with its fields in another order, a decision whose event lost
// its slice; S2 set aside, then started again, with a worker result whose session is not on record; S2B a
// prerequisite; S3 whose session file is gone; a FINAL step replayed, with no verification recorded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const T0 = Date.parse('2026-11-01T10:00:00Z');
export const at = (min) => new Date(T0 + min * 60000).toISOString();
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-setup-scorecard-'));
export function writeLines(file, lines, tail = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n' + tail);
}
export const assistant = (min, cost, model = 'm1', provider = 'anthropic') => ({ type: 'message', timestamp: at(min),
  message: { role: 'assistant', model, provider, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: cost } } } });

export function topicEvents() {
  let clock = 0;
  const ev = (type, fields = {}) => ({ t: at(clock++), run: 'r1', topic: 't', slice: null, type, ...fields });
  return [
    ev('run_start', { resumed: false, roles: { implementer: { model: 'p/impl-model' }, reviewer: { model: 'p/rev-model' } } }),
    ev('slice_start', { slice: 'S1', title: 'One', base: 'a' }),
    ev('agent_start', { slice: 'S1', role: 'implementer', session: 'imp1' }),
    ev('step_sent', { slice: 'S1', role: 'implementer', purpose: 'implement' }),
    ev('advisor_start', { slice: 'S1' }),
    ev('advisor_brief', { slice: 'S1', revisits: ['D1'] }),
    ev('operator_wait_start', { slice: 'S1', role: 'advisor', status: 'needs-decision' }),
    ev('operator_wait_end', { slice: 'S1', role: 'advisor', waitedMs: 3600000 }),
    ev('owner_decision', { slice: 'Some title from an old relay', id: 'D2', chosen: 1 }),
    ev('advisor_start', { slice: 'S1' }),
    ev('advisor_brief', { slice: 'S1' }),
    ev('council_decision', { slice: null, id: 'D3' }),
    ev('nudge', { slice: 'S1', role: 'implementer', purpose: 'implement', reason: 'missing-result' }),
    ev('step_result', { slice: 'S1', role: 'implementer', purpose: 'implement', status: 'done', usage: { costUsd: 5 } }),
    ev('agent_start', { slice: 'S1', role: 'reviewer', session: 'rev1' }),
    ev('step_sent', { slice: 'S1', role: 'reviewer', purpose: 'review' }),
    ev('step_result', { slice: 'S1', role: 'reviewer', purpose: 'review', verdict: 'changes-required', blocking: ['R1', 'R2'], usage: { costUsd: 2 } }),
    ev('step_sent', { slice: 'S1', role: 'implementer', purpose: 'repair1' }),
    ev('step_result', { slice: 'S1', role: 'implementer', purpose: 'repair1', status: 'done', usage: { costUsd: 3 } }),
    ev('step_sent', { slice: 'S1', role: 'reviewer', purpose: 'rereview1' }),
    ev('step_result', { slice: 'S1', role: 'reviewer', purpose: 'rereview1', verdict: 'changes-required', blocking: ['R1', 'R3'], usage: { costUsd: 1 } }),
    ev('step_result', { usage: { costUsd: 1 }, blocking: ['R1', 'R3'], verdict: 'changes-required', purpose: 'rereview1', role: 'reviewer', slice: 'S1' }),
    ev('step_sent', { slice: 'S1', role: 'senior', purpose: 'repair2' }),
    ev('agent_start', { slice: 'S1', role: 'senior', session: 'sen1' }),
    ev('step_result', { slice: 'S1', role: 'senior', purpose: 'repair2', status: 'done', usage: { costUsd: 4 } }),
    ev('escalation', { slice: 'S1' }),
    ev('step_sent', { slice: 'S1', role: 'reviewer', purpose: 'rereview2' }),
    ev('step_result', { slice: 'S1', role: 'reviewer', purpose: 'rereview2', verdict: 'accept', blocking: [], usage: { costUsd: 1 } }),
    ev('slice_done', { slice: 'S1', commits: ['c1', 'c2'] }),
    ev('slice_start', { slice: 'S2', title: 'Two', needs: ['acceptance'] }),
    ev('agent_start', { slice: 'S2', role: 'acceptance', session: 'acc2' }),
    ev('slice_set_aside', { slice: 'S2' }),
    ev('slice_start', { slice: 'S2B', title: 'Prerequisite' }),
    ev('slice_done', { slice: 'S2B', commits: [] }),
    ev('slice_resumed', { slice: 'S2' }),
    ev('slice_start', { slice: 'S2', title: 'Two' }),
    ev('step_result', { slice: 'S2', role: 'implementer', purpose: 'implement', status: 'done', usage: null }),
    ev('acceptance_compared', { slice: 'S2', changed: ['a.test'], missing: [] }),
    ev('acceptance_compared', { slice: 'S2', changed: ['a.test'], missing: [] }),
    ev('agent_start', { slice: 'S2', role: 'reviewer', session: 'rev2' }),
    ev('step_sent', { slice: 'S2', role: 'reviewer', purpose: 'review' }),
    ev('step_result', { slice: 'S2', role: 'reviewer', purpose: 'review', verdict: 'accept', blocking: [] }),
    ev('slice_done', { slice: 'S2', commits: ['c3'] }),
    ev('slice_start', { slice: 'S3', title: 'Three' }),
    ev('agent_start', { slice: 'S3', role: 'implementer', session: 'gone3' }),
    ev('step_result', { slice: 'S3', role: 'implementer', purpose: 'implement', status: 'done' }),
    ev('slice_done', { slice: 'S3', commits: [] }),
    ev('agent_start', { slice: 'FINAL', role: 'implementer', session: 'fin' }),
    ev('step_result', { slice: 'FINAL', role: 'implementer', purpose: 'final', status: 'done', verification: null }),
    ev('step_result', { slice: 'FINAL', role: 'implementer', purpose: 'final', status: 'done', verification: null }),
    ev('operator_wait_start', { slice: 'FINAL', role: 'implementer', status: 'blocked' }),
    ev('run_stop', { kind: 'stop', reason: 'stopped by the owner' }),
    { ...ev('run_start', { resumed: true }), run: 'r2' },
  ];
}

const costs = { imp1: 10, rev1: 3, sen1: 5, rev2: 1, acc2: 2, fin: 0.5 };
export const readFake = (p) => (p in costs
  ? { total: { calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: costs[p], cacheWarmUsd: 0, compactionUsd: 0 },
    byModel: { 'anthropic/m1': { calls: 1, costUsd: costs[p] } }, entries: [[T0, costs[p], 'anthropic']], unreadable: 0 }
  : { missing: 'session file gone' });
