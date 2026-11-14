#!/usr/bin/env node
// Scorecard: measures of relay work, read from the records runs leave (events.jsonl and the Pi session files
// they name). Read-only. How the figures are defined and used to judge a change: EVALUATION.md.
//
//   node scripts/scorecard.mjs PATH...   a summary per topic (PATH: a topic directory, its relay/ directory, or a
//                                        project: every topic under its .agents_work/); with several topics, a
//                                        table of them first
//   --detail                             also the per-slice, per-role and per-model tables
//   --compare DATE|acceptance            slices finished before DATE versus started after it (slices running
//                                        across it are left out and named), or without versus with the
//                                        acceptance step
//   --since DATE                         only slices finished since DATE; also the spend since DATE (by the
//                                        time of each model call)
//   --until DATE                         cutoff: events and model calls after DATE are ignored
//   --size                               lines changed per slice (git diff --shortstat base..head in the project)
//
// Modules: scorecard/records.mjs (finding and reading records), measures.mjs (one pass over the events),
// costs.mjs (sessions, cost shares, quota), report.mjs (cohorts, summary, comparisons, project table),
// detail.mjs (the detail tables).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCosts } from './scorecard/costs.mjs';
import { detail } from './scorecard/detail.mjs';
import { analyzeTopic } from './scorecard/measures.mjs';
import { findTopics, gitShortstat, readEvents } from './scorecard/records.mjs';
import { compare, inPeriod, iso, phoneSummary, projectTable } from './scorecard/report.mjs';

export function parseArgs(argv) {
  const opts = { paths: [], detail: false, compare: null, sinceMs: null, untilMs: null, size: false };
  const date = (flag, v) => {
    const t = Date.parse(v ?? '');
    if (!Number.isFinite(t)) throw new Error(`${flag} needs a date (for example 2026-11-12 or 2026-11-12T19:04Z), got "${v ?? ''}"`);
    return t;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--detail') opts.detail = true;
    else if (a === '--size') opts.size = true;
    else if (a === '--compare') {
      opts.compare = argv[++i];
      if (opts.compare !== 'acceptance') date('--compare', opts.compare);
    } else if (a === '--since') opts.sinceMs = date('--since', argv[++i]);
    else if (a === '--until') opts.untilMs = date('--until', argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (!opts.paths.length) throw new Error('name at least one topic or project directory');
  return opts;
}

export function analyze(topic, opts, readSessionFile) {
  const { events, unreadable, partialTail } = readEvents(topic.events);
  const kept = opts.untilMs === null ? events : events.filter((e) => Date.parse(e.t) <= opts.untilMs);
  const result = analyzeTopic(topic.name, kept);
  if (opts.untilMs !== null) result.topic.cutoffMs = opts.untilMs; // the cutoff given, not the last event before it
  addCosts(result, { cutoffMs: result.topic.cutoffMs ?? Infinity, ...(readSessionFile ? { readSessionFile } : {}) });
  if (opts.size) {
    const root = path.dirname(path.dirname(topic.dir)); // <project>/.agents_work/<topic>
    for (const s of result.slices) if (s.doneAt !== null) s.lines = gitShortstat(root, s.base, s.head);
  }
  return { ...result, unreadable, partialTail, eventsFile: topic.events };
}

export function report(r, opts) {
  const parts = [phoneSummary(r, opts)];
  if (r.unreadable || r.partialTail) parts.push(`(records: ${r.unreadable} unreadable lines${r.partialTail ? ', last line incomplete (ignored)' : ''})`);
  if (opts.untilMs !== null) parts.push(`(cutoff given: ${iso(opts.untilMs)})`);
  if (opts.detail) parts.push('', detail(inPeriod(r, opts.sinceMs), { eventsFile: r.eventsFile }));
  if (opts.compare) parts.push('', compare(inPeriod(r, opts.sinceMs), opts.compare));
  return parts.join('\n');
}

export function main(argv, readSessionFile) {
  const opts = parseArgs(argv);
  const results = findTopics(opts.paths).map((t) => analyze(t, opts, readSessionFile));
  const head = results.length > 1 ? [projectTable(results.map((r) => inPeriod(r, opts.sinceMs))), ''] : [];
  return [...head, ...results.map((r) => report(r, opts))].join('\n\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (e) {
    process.stderr.write(`scorecard: ${e.message}\n`);
    process.exit(2);
  }
}
