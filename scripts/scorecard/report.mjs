// Scorecard: cohorts of finished slices, the phone summary, before/after comparisons and the project table.

import { checkingUsd, stepShares } from './costs.mjs';
import { latency, waited } from './measures.mjs';

export const money = (n) => (Math.abs(n) < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString('en-US')}`);
export const hours = (ms) => `${(ms / 3600000).toFixed(1)}h`;
export const iso = (ms) => (ms === null ? 'n/a' : new Date(ms).toISOString().replace('.000Z', 'Z'));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
const sum = (xs) => xs.reduce((n, x) => n + x, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function median(xs) {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const values = (xs, fmt = String) => (xs.length > 12 ? `range ${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}` : `[${xs.map(fmt).join(', ')}]`);

// The figures of a group of slices; only finished ones count, and only fully recorded ones are priced.
export function cohort(slices) {
  const done = slices.filter((s) => s.doneAt !== null);
  const priced = done.filter((s) => !s.partial.length);
  const known = done.filter((s) => s.firstReview === 'accept' || s.firstReview === 'changes-required');
  const shares = priced.map(stepShares);
  const byStatus = {};
  for (const s of done) for (const [k, v] of Object.entries(s.waitedByStatus)) byStatus[k] = (byStatus[k] ?? 0) + v;
  const total = (f) => sum(done.map(f));
  return {
    n: done.length, ids: done.map((s) => s.id), loops: done.map((s) => s.loops),
    firstPass: { known: known.length, accepted: known.filter((s) => s.firstReview === 'accept').length },
    escalations: total((s) => s.escalations), ambiguous: total((s) => s.ambiguous), runaways: total((s) => s.runaways),
    returning: { ids: total((s) => s.returning.size), slices: done.filter((s) => s.returning.size).length },
    acceptance: { slices: done.filter((s) => s.acceptanceStep).length, changedFiles: total((s) => s.acceptanceChanged.size) },
    owner: { decisions: total((s) => s.ownerDecisions), chosenKnown: total((s) => s.chosenKnown), recommended: total((s) => s.chosenRecommended) },
    revisits: ['known', 'proposed', 'owner', 'council'].reduce((o, k) => ({ ...o, [k]: total((s) => s.revisits[k]) }), {}),
    waitedMs: total(waited), byStatus, untimedWaits: total((s) => s.untimedWaits),
    pausedMs: total((s) => s.pausedMs), untimedPauses: total((s) => s.untimedPauses),
    council: total((s) => s.councilDecisions), councilReturned: total((s) => s.councilReturned),
    latency: done.map(latency).filter((x) => x !== null),
    priced: priced.length, partial: done.length - priced.length, costs: priced.map((s) => s.cost.costUsd),
    reviewCycleUsd: sum(shares.map((x) => x.reviewCycleUsd)), nudgedUsd: sum(shares.map((x) => x.nudgedUsd)),
    supersededUsd: total((s) => s.supersededUsd ?? 0), lines: done.map((s) => s.lines).filter((x) => Number.isFinite(x)),
  };
}

const waitText = (c) => `${hours(c.waitedMs)}${Object.keys(c.byStatus).length > 1 || c.byStatus.blocked
  ? `: ${Object.entries(c.byStatus).map(([k, v]) => `${k === 'needs-decision' ? 'decisions' : k} ${hours(v)}`).join(', ')}` : ''}`
  + `${c.untimedWaits ? ` + ${c.untimedWaits} untimed` : ''}`;
const recommended = (o) => (o.chosenKnown ? `${o.recommended} of ${o.chosenKnown} recommended` : 'recommended: not recorded');

export function finalText(r) {
  const runs = r.special.get('FINAL')?.verifications ?? [];
  if (!runs.length) return 'not run yet';
  const findings = r.special.get('FINAL').finalFindings;
  return `${plural(runs.length, 'run')}: ${runs.map((v) => v ?? 'verification not recorded').join(', ')}`
    + `${findings ? ` · ${plural(findings, 'review')} with findings` : ''}`;
}

export function phoneSummary(r, { sinceMs = null } = {}) {
  const { topic } = r;
  const inPeriod = (s) => s.doneAt !== null && (sinceMs === null || s.doneAt >= sinceMs);
  const c = cohort(r.slices.filter(inPeriod));
  const rest = r.slices.filter((s) => !inPeriod(s));
  const notFinished = rest.filter((s) => s.doneAt === null).length;
  const outside = {
    owner: topic.ownerDecisions - c.owner.decisions, council: topic.councilDecisions - c.council,
    usd: topic.cost.total.costUsd - sum(r.slices.filter(inPeriod).map((s) => s.cost.costUsd)),
    waitedMs: topic.waitedMs - c.waitedMs, untimed: topic.untimedWaits - c.untimedWaits,
  };
  const cost = topic.cost.total.costUsd;
  const lines = [
    `${topic.name} · ${c.n} finished slices${sinceMs !== null ? ` since ${iso(sinceMs)}` : ''}${notFinished ? `, ${notFinished} not finished` : ''} · up to ${iso(topic.cutoffMs)}`,
    'quality   not assessed by reading (EVALUATION.md, judging step 4)',
    `final     ${finalText(r)}`,
    `reviews   ${(sum(c.loops) / (c.n || 1)).toFixed(2)} loops per slice · first review accepted ${c.firstPass.accepted} of ${c.firstPass.known} known`
      + ` · ${c.escalations} escalations · ${c.returning.ids} findings back after repair (${c.returning.slices} slices)`,
    `you       ${c.owner.decisions} decisions (${recommended(c.owner)}) · waited ${waitText(c)}`
      + `${c.revisits.known ? ` · revisits proposed in ${c.revisits.proposed} of ${c.revisits.known} briefs` : ''}`,
    `council   ${c.council} decisions · ${c.councilReturned} votes returned to you`,
    `cost      ${money(cost)} recorded${topic.cost.missing + topic.cost.unreadable ? ` (${plural(topic.cost.missing + topic.cost.unreadable, 'session')} missing or partial)` : ''}`
      + ` · ${c.priced ? `${money(sum(c.costs) / c.priced)} per finished slice (${c.priced} of ${c.n} fully recorded)` : 'no fully recorded slice'}`
      + ` · review cycles ~${pct(c.reviewCycleUsd, sum(c.costs))} of those · checking ${pct(checkingUsd(topic), cost)} of all`,
    `outside   other slices, planning and final: ${plural(outside.owner, 'decision')} by you, ${outside.council} by the council`
      + ` · waited ${hours(outside.waitedMs)}${outside.untimed ? ` + ${outside.untimed} untimed` : ''} · ${money(outside.usd)}`,
  ];
  if (sinceMs !== null) {
    const spend = sum(topic.cost.entries.filter(([at]) => at >= sinceMs).map(([, x]) => x));
    lines.push(`period    ${money(spend)} spent since ${iso(sinceMs)} (by the time of each model call)`);
  }
  return lines.join('\n');
}

// Two groups side by side. A date splits finished slices into those finished before it and those whose first
// event is after it; a slice running across the date is left out and named. 'acceptance' splits by the step.
// With --since, the detail, comparisons and project table keep the slices finished in the period too.
export const inPeriod = (r, sinceMs) => (sinceMs === null ? r : { ...r, slices: r.slices.filter((s) => s.doneAt !== null && s.doneAt >= sinceMs) });

export function compare(r, split) {
  const done = r.slices.filter((s) => s.doneAt !== null);
  let groups;
  let label;
  let crossing = [];
  if (split === 'acceptance') {
    groups = [done.filter((s) => !s.acceptanceStep), done.filter((s) => s.acceptanceStep)];
    label = ['without the acceptance step', 'with it'];
  } else {
    const b = Date.parse(split);
    groups = [done.filter((s) => s.doneAt < b), done.filter((s) => s.firstAt >= b)];
    crossing = done.filter((s) => s.firstAt < b && s.doneAt >= b).map((s) => s.id);
    label = [`finished before ${iso(b)}`, 'started after'];
  }
  const [a, z] = groups.map(cohort);
  const row = (name, f) => `| ${name} | ${f(a)} | ${f(z)} |`;
  return [
    `### ${r.topic.name}: ${label[0]} (${a.n}) versus ${label[1]} (${z.n})${crossing.length ? `; left out, running across the date: ${crossing.join(', ')}` : ''}`, '',
    `| Measure | ${label[0]} | ${label[1]} |`, '|---|---|---|',
    row('Review loops per slice', (c) => `median ${median(c.loops) ?? '–'} ${values(c.loops)}`),
    row('First review accepted', (c) => `${c.firstPass.accepted} of ${c.firstPass.known} known`),
    row('Escalations', (c) => `${c.escalations} in ${c.n} slices`),
    row('Findings back after repair', (c) => `${c.returning.ids} in ${c.returning.slices} of ${c.n} slices`),
    row('Owner decisions', (c) => `${c.owner.decisions} in ${c.n} slices (${recommended(c.owner)})`),
    row('Owner wait', waitText),
    row('Council decisions', (c) => `${c.council} in ${c.n} slices · ${c.councilReturned} votes returned`),
    row('Revisits proposed', (c) => `${c.revisits.proposed} of ${c.revisits.known} known briefs (decided: owner ${c.revisits.owner}, council ${c.revisits.council})`),
    row('Latency', (c) => (c.latency.length ? `median ${hours(median(c.latency))} ${values(c.latency, hours)}` : '–')),
    row('Cost per slice', (c) => (c.priced ? `median ${money(median(c.costs))} ${values(c.costs, money)} (${c.partial} partial left out)` : '–')),
    row('Review-cycle share (approx.)', (c) => pct(c.reviewCycleUsd, sum(c.costs))),
    row('Lines changed', (c) => (c.lines.length ? `median ${median(c.lines)} ${values(c.lines)}` : 'not measured (--size)')),
  ].join('\n');
}

export function models(topic) {
  const seen = new Set();
  for (const run of topic.runs) {
    const m = (role) => run.roles?.[role]?.model?.replace(/^.*\//, '') ?? '?';
    if (run.roles) seen.add(`${m('implementer')}/${m('reviewer')}`);
  }
  return [...seen].join(', ') || 'not recorded';
}

export function projectTable(results) {
  const out = ['| Topic | From | Finished | Loops/slice | First review accepted | Owner decisions | Waited (finished slices) | Cost/slice | Implementer/reviewer |',
    '|---|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    const c = cohort(r.slices);
    out.push(`| ${r.topic.name} | ${iso(r.topic.runs[0]?.at ?? null).slice(0, 10)} | ${c.n} | ${(sum(c.loops) / (c.n || 1)).toFixed(2)}`
      + ` | ${c.firstPass.accepted}/${c.firstPass.known} | ${c.owner.decisions} | ${hours(c.waitedMs)}`
      + ` | ${c.priced ? money(sum(c.costs) / c.priced) : '–'} | ${models(r.topic)} |`);
  }
  return out.join('\n');
}
