// Scorecard: several topics as one, for a view over many handoffs (and several projects) in a period.

import { addCost, zeroCost } from './records.mjs';
import { compare, inPeriod, iso, money, phoneSummary, projectTable } from './report.mjs';

const TOTALS = ['ownerDecisions', 'councilDecisions', 'waitedMs', 'untimedWaits'];

// One result built from several, for the summary, the table's total row and comparisons (not the detail
// tables): slices keep their records under "topic/id"; topic totals, costs, waits and the final verifications
// add up. Each topic's costs run to its own cutoff, so "up to" is the latest of them.
export function combine(results, name) {
  const topic = {
    name, runs: [], cutoffMs: Math.max(...results.map((r) => r.topic.cutoffMs ?? -Infinity)),
    cost: { total: zeroCost(), byRole: {}, missing: 0, unreadable: 0, entries: [] },
  };
  for (const k of TOTALS) topic[k] = 0;
  const final = { verifications: [], finalFindings: 0, topics: 0, of: results.length };
  const slices = [];
  for (const { topic: t, slices: ss, special } of results) {
    for (const k of TOTALS) topic[k] += t[k] ?? 0;
    topic.runs.push(...t.runs);
    addCost(topic.cost.total, t.cost.total);
    for (const [k, v] of Object.entries(t.cost.byRole)) addCost(topic.cost.byRole[k] ??= zeroCost(), v);
    topic.cost.missing += t.cost.missing;
    topic.cost.unreadable += t.cost.unreadable;
    for (const en of t.cost.entries) topic.cost.entries.push(en);
    const f = special.get('FINAL');
    if (f?.verifications.length) { final.verifications.push(...f.verifications); final.finalFindings += f.finalFindings; final.topics++; }
    for (const s of ss) slices.push({ ...s, id: `${t.name}/${s.id}` });
  }
  if (topic.cutoffMs === -Infinity) topic.cutoffMs = null;
  topic.runs.sort((a, b) => a.at - b.at);
  return { topic, slices, special: new Map(final.topics ? [['FINAL', final]] : []) };
}

// Topics with a slice finished in the period (any finished slice without --since); the others are left out.
export const active = (r, sinceMs) => inPeriod(r, sinceMs).slices.some((s) => s.doneAt !== null);

// The view over several topics: the table with its total row, what was left out, one summary, a comparison.
// Damaged event records are named whichever topics are shown.
export function overall(results, opts) {
  const shown = results.filter((r) => active(r, opts.sinceMs));
  const left = results.filter((r) => !shown.includes(r));
  const damaged = results.filter((r) => r.unreadable || r.partialTail)
    .map((r) => `${r.topic.name} (${r.unreadable} unreadable lines${r.partialTail ? ', last line incomplete' : ''})`);
  const notes = [
    left.length ? `(${left.length} topic${left.length === 1 ? '' : 's'} with no slice finished${opts.sinceMs === null ? '' : ' in the period'} left out;`
      + ` ${money(left.reduce((n, r) => n + r.topic.cost.entries.filter(([at]) => opts.sinceMs === null || at >= opts.sinceMs).reduce((m, [, x]) => m + x, 0), 0))}`
      + ` spent in them${opts.sinceMs === null ? '' : ` since ${iso(opts.sinceMs)}`})` : null,
    damaged.length ? `(records: ${damaged.join('; ')})` : null,
  ].filter(Boolean);
  if (!shown.length) return [results.length ? 'No topic has a slice finished in the period.' : 'No relay topics found.', ...notes].join('\n');
  const all = combine(shown, `all topics (${shown.length})`);
  return [
    projectTable([...shown, all].map((r) => inPeriod(r, opts.sinceMs))), ...notes,
    '', phoneSummary(all, opts), opts.untilMs !== null ? `(cutoff given: ${iso(opts.untilMs)})` : null,
    opts.compare ? `\n${compare(inPeriod(all, opts.sinceMs), opts.compare)}` : null,
  ].filter((x) => x !== null).join('\n');
}

// Topics of the same name from different projects are told apart by their project's folder name.
export function nameTopics(topics) {
  const seen = {};
  for (const t of topics) seen[t.name] = (seen[t.name] ?? 0) + 1;
  for (const t of topics) if (seen[t.name] > 1) t.name = `${t.dir.split('/').at(-3) ?? '?'}/${t.name}`;
  return topics;
}
