// Scorecard: the detail tables of one topic (per slice, role and model), with what the records cover.

import { quotaChange, stepShares } from './costs.mjs';
import { latency, waited } from './measures.mjs';
import { cohort, finalText, hours, iso, median, money } from './report.mjs';

function notes(s) {
  return [
    s.doneAt === null && (s.startAt !== null ? 'no completion on record' : 'no start on record'),
    s.starts > 1 && `${s.starts} attempts (earlier ones ${money(s.supersededUsd ?? 0)})`,
    s.asides.length && `set aside ${hours(s.asides.reduce((n, [a, b]) => n + b - a, 0))}`,
    s.acceptanceStep && 'tests first', s.acceptanceChanged.size && `${s.acceptanceChanged.size} test files changed`,
    s.partial.length && `partial cost (${s.partial.join('; ')})`, s.gapMs && `${hours(s.gapMs)} between relay runs`,
    s.pausedMs && `quota pauses ${hours(s.pausedMs)}`, s.untimedPauses && `${s.untimedPauses} untimed quota pauses`,
    s.untimedWaits && `${s.untimedWaits} untimed waits`, s.runaways && `${s.runaways} runaway steps`,
    Object.keys(s.nudges).length && `nudges ${Object.entries(s.nudges).map(([k, v]) => `${v} ${k}`).join(', ')}`,
    s.ambiguous && `${s.ambiguous} results of one step without a new send (ambiguous)`,
    s.revisits.proposed && `${s.revisits.proposed} revisits proposed`, Number.isFinite(s.lines) && `${s.lines} lines changed`,
    s.versions.size && `version ${[...s.versions].join(' + ')}`,
  ].filter(Boolean).join('; ');
}

function roleModels(topic) {
  const byRole = {};
  for (const run of topic.runs) for (const [role, v] of Object.entries(run.roles ?? {})) (byRole[role] ??= new Set()).add(v?.model ?? '?');
  return Object.entries(byRole).map(([role, m]) => `${role} ${[...m].join(' + ')}`).join(', ') || 'not recorded';
}

export function detail(r, { eventsFile = null } = {}) {
  const { topic, slices } = r;
  const c = cohort(slices);
  const q = quotaChange(topic.quota);
  const span = topic.quota.length ? [topic.quota[0].at, topic.quota.at(-1).at] : null;
  const anthropic = span ? topic.cost.entries.filter(([at, , pv]) => pv === 'anthropic' && at >= span[0] && at <= span[1]).reduce((n, [, x]) => n + x, 0) : 0;
  const versioned = slices.filter((s) => s.versions.size).length;
  const out = [`## ${topic.name}`, '',
    `Records: ${eventsFile ?? 'events'} up to ${iso(topic.cutoffMs)}; ${topic.runs.length} relay runs; ${topic.sessions.size} sessions`
    + ` named by its agent_start events (${topic.cost.missing} missing, ${topic.cost.unreadable} with unreadable lines). Models by role: ${roleModels(topic)}.`
    + ` Relay version recorded for ${versioned} of ${slices.length} slices. Dollar figures are Pi-recorded price equivalents. Times are UTC.`, '',
    '| Slice | Title | Latency | Loops | First review | Back after repair | Esc. | You | Council | Waited | Cost | Review cycles | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of slices) {
    const l = latency(s);
    out.push(`| ${s.id} | ${(s.title ?? '').slice(0, 40)} | ${l === null ? '–' : hours(l)} | ${s.loops} | ${s.firstReview ?? 'unknown'}`
      + ` | ${s.returning.size} | ${s.escalations} | ${s.ownerDecisions} | ${s.councilDecisions} | ${hours(waited(s))}`
      + ` | ${money(s.cost.costUsd)} | ${money(stepShares(s).reviewCycleUsd)} | ${notes(s)} |`);
  }
  out.push('', '| Role | Cost | Calls | Cache warming | Compactions |', '|---|---|---|---|---|');
  for (const [role, k] of Object.entries(topic.cost.byRole).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
    out.push(`| ${role} | ${money(k.costUsd)} | ${k.calls} | ${money(k.cacheWarmUsd)} | ${money(k.compactionUsd)} |`);
  }
  out.push('', '| Model | Cost | Input | Output | Cache read | Cache write |', '|---|---|---|---|---|---|');
  for (const [m, k] of Object.entries(topic.cost.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
    out.push(`| ${m} | ${money(k.costUsd)} | ${k.input} | ${k.output} | ${k.cacheRead} | ${k.cacheWrite} |`);
  }
  const outside = Object.entries(topic.cost.outside).map(([k, v]) => `${k} ${money(v.costUsd)}`).join(', ');
  out.push('', `Final verification: ${finalText(r)}; relay completions recorded: ${topic.completions.map((v) => v ?? 'verification not recorded').join(', ') || 'none'}.`);
  out.push(`Outside slices: ${outside || 'none'}. Latency median ${c.latency.length ? hours(median(c.latency)) : 'n/a'} over ${c.latency.length} finished slices.`
    + ` Earlier attempts ${money(c.supersededUsd)}; nudged steps ${money(c.nudgedUsd)} (step usage). Commits per slice: median`
    + ` ${median(slices.filter((s) => s.commits !== null).map((s) => s.commits)) ?? 'n/a'}. Plan size: ${slices.some((s) => s.plan) ? 'recorded at slice starts' : 'not recorded'}.`);
  out.push(`Friction: nudges ${JSON.stringify(topic.nudges)}, stops ${JSON.stringify(topic.stops)} (${topic.planStops} naming plan.md),`
    + ` ${c.runaways} runaway steps, quota pauses ${hours(c.pausedMs)}${c.untimedPauses ? ` + ${c.untimedPauses} untimed` : ''}, restarts ${Math.max(0, topic.runs.length - 1)}.`);
  out.push(`Quota (account-wide, shared with other sessions): ${q.points} points observed over ${q.readings} readings in ${q.windows} windows`
    + `${anthropic ? `; ${(q.points / (anthropic / 100)).toFixed(1)} points per $100 of Anthropic-model cost in that span` : ''}`
    + `${Object.keys(q.byDay).length ? `; by day ${Object.entries(q.byDay).map(([d, p]) => `${d} ${p}`).join(', ')}` : ''}.`);
  out.push('', '| Session file | Slice | Role | Cost |', '|---|---|---|---|');
  for (const [key, info] of topic.sessions) {
    const c = topic.cost.bySession[key];
    out.push(`| ${info.path ?? 'none recorded'} | ${info.slice ?? '–'} | ${info.role} | ${c === undefined ? 'missing' : money(c)} |`);
  }
  return out.join('\n');
}
