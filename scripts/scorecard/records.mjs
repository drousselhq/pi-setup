// Scorecard: finding relay topics and reading their records (events.jsonl and the Pi session files they name).
// Read-only. Nothing here interprets the records; measures.mjs does.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A path names one topic (its directory, or its relay/ directory) or a project (every topic under .agents_work/).
export function findTopics(paths) {
  const topics = [];
  const add = (dir) => topics.push({ dir, name: path.basename(dir), events: path.join(dir, 'relay', 'events.jsonl') });
  for (const p of paths) {
    const abs = path.resolve(p);
    if (fs.existsSync(path.join(abs, 'events.jsonl')) && path.basename(abs) === 'relay') add(path.dirname(abs));
    else if (fs.existsSync(path.join(abs, 'relay', 'events.jsonl'))) add(abs);
    else if (fs.existsSync(path.join(abs, '.agents_work'))) {
      const work = path.join(abs, '.agents_work');
      for (const name of fs.readdirSync(work).sort()) {
        if (fs.existsSync(path.join(work, name, 'relay', 'events.jsonl'))) add(path.join(work, name));
      }
    } else throw new Error(`${p}: not a relay topic (no relay/events.jsonl) nor a project (no .agents_work/)`);
  }
  return topics;
}

// Events in file order. A last line without its newline that does not parse is a write in progress: ignored.
// Any other unreadable line is counted, never skipped silently.
export function readEvents(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const tail = lines.pop(); // '' when the file ends with a newline
  const events = [];
  let unreadable = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { unreadable++; }
  }
  let partialTail = false;
  if (tail.trim()) {
    try { events.push(JSON.parse(tail)); } catch { partialTail = true; }
  }
  return { events, unreadable, partialTail };
}

export const zeroCost = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, cacheWarmUsd: 0, compactionUsd: 0 });

function addUsage(totals, u, kind) {
  totals.calls++;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) totals[k] += u[k] ?? 0;
  const cost = u.cost?.total ?? 0;
  totals.costUsd += cost;
  if (kind === 'cache_warm') totals.cacheWarmUsd += cost;
  if (kind === 'compaction') totals.compactionUsd += cost;
  return cost;
}

// Everything Pi recorded as spent in one session, up to the cutoff: assistant replies, cache warming and
// compactions, each with its own model. `entries` keeps [time, cost, provider] for calendar periods.
// A complete line that does not parse, or a usage entry without a valid time, makes the session partial
// (`unreadable`); a last line without its newline is a write in progress and is ignored.
export function readSession(file, cutoffMs = Infinity) {
  if (!file) return { missing: 'no session recorded' };
  if (!fs.existsSync(file)) return { missing: 'session file gone' };
  const total = zeroCost();
  const byModel = {};
  const entries = [];
  let model = null;
  let provider = null;
  let unreadable = 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const tail = lines.pop(); // complete only if it parses: otherwise a write in progress
  try { JSON.parse(tail); lines.push(tail); } catch { /* ignored */ }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { unreadable++; continue; } // a damaged line, whatever it held
    const at = Date.parse(e.timestamp);
    if (e.type === 'model_change') { model = e.modelId ?? model; provider = e.provider ?? provider; continue; }
    let u = null;
    let kind = null;
    let m = model;
    let pv = provider;
    if (e.type === 'message' && e.message?.role === 'assistant' && e.message.usage) {
      u = e.message.usage; m = e.message.model ?? m; pv = e.message.provider ?? pv;
    } else if (e.type === 'usage' && e.usage) {
      u = e.usage; kind = e.kind ?? 'usage'; m = e.model ?? m; pv = e.provider ?? pv;
    } else if (e.type === 'compaction' && e.usage) {
      u = e.usage; kind = 'compaction';
    }
    if (!u) continue;
    if (!Number.isFinite(at)) { unreadable++; continue; }
    if (at > cutoffMs) continue;
    const cost = addUsage(total, u, kind);
    addUsage(byModel[m ? `${pv ? `${pv}/` : ''}${m}` : 'unknown'] ??= zeroCost(), u, kind);
    entries.push([at, cost, pv]);
  }
  return { total, byModel, entries, unreadable };
}

export function addCost(into, from) {
  for (const k of Object.keys(into)) into[k] += from?.[k] ?? 0;
  return into;
}

// Lines added and removed between a slice's base and head in the project checkout, or null when unknown.
export function gitShortstat(root, base, head) {
  if (!base || !head) return null;
  const r = spawnSync('git', ['-C', root, 'diff', '--shortstat', base, head], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const n = (word) => Number(r.stdout.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  return n('insertion') + n('deletion');
}
