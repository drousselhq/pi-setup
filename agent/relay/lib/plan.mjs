// pi-relay: plan.md parsing, the built-in PLAN and FINAL slices, slice order and progress.

import fs from 'node:fs';
import { C } from './console.mjs';
import { ctx, plural, RelayStop, state } from './runtime.mjs';

// Deterministic progress: slices and acceptance bullets of accepted slices, from plan.md and state.
export function progress() {
  const slices = parsePlan();
  const done = slices.filter((x) => state.slices[x.id]?.status === 'done');
  const sum = (list) => list.reduce((n, x) => n + x.acceptance, 0);
  const finished = Object.values(state.slices);
  return {
    slices: slices.length, slicesDone: done.length,
    criteria: sum(slices), criteriaMet: sum(done),
    loops: finished.reduce((n, x) => n + (x.cycles ?? 0), 0) + (state.cur?.cycle ?? 0),
    compactions: finished.reduce((n, x) => n + (x.compactions ?? 0), 0) + (state.cur?.compactions ?? 0),
    index: (id) => slices.findIndex((x) => x.id === id) + 1,
  };
}

export function progressText(pr) {
  return [
    `slices ${pr.slicesDone}/${pr.slices}`,
    pr.criteria ? `acceptance ${pr.criteriaMet}/${pr.criteria}` : null,
    plural(pr.loops, 'review loop'),
    plural(pr.compactions, 'compaction'),
  ].filter(Boolean).join(' \u00b7 ');
}

export function parsePlan() {
  if (!fs.existsSync(ctx.plan)) return [];
  const slices = [];
  let cur = null;
  for (const line of fs.readFileSync(ctx.plan, 'utf8').split('\n')) {
    const m = line.match(/^##\s+(S\d+[a-z]?)\s*[:—–-]\s*(.+?)\s*$/i);
    if (m) {
      cur = { id: m[1].toUpperCase(), title: m[2], lines: [line], needs: [], acceptance: 0, inAcceptance: false };
      slices.push(cur);
    } else if (/^#{1,2}\s/.test(line)) {
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
      const n = line.match(/^\W*needs\W*:\s*(.+)$/i);
      if (n) cur.needs = n[1].toLowerCase().split(/[,\s]+/).filter((x) => ['scout', 'architecture', 'acceptance'].includes(x));
      // Acceptance criteria: the bullets under "Acceptance:" (or one inline criterion after the colon).
      const a = line.match(/^\W*acceptance\W*:\s*(.*)$/i);
      if (a) { cur.inAcceptance = true; if (a[1].trim()) cur.acceptance++; }
      else if (cur.inAcceptance && /^\s*([-*+]|\d+[.)])\s+\S/.test(line)) cur.acceptance++;
      else if (cur.inAcceptance && line.trim() && !/^\s{2,}\S/.test(line)) cur.inAcceptance = false;
    }
  }
  const ids = slices.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new RelayStop(`plan.md defines slice ${dup} twice.`);
  return slices.map(({ inAcceptance, ...s }) => ({ ...s, body: s.lines.join('\n').trim() }));
}

// The plan.md format, written into the planner's assignment. The relay README shows the same block
// (a test keeps them identical). parsePlan() reads the "## S<n>: title" headings, the Needs: line
// and the Acceptance: bullets.
export const PLAN_FORMAT = `\`\`\`markdown
# Plan: <outcome in plain words>

## S1: <slice title>
Needs: none
Acceptance:
- <observable condition>
Notes: <entry points, scope limits, dependencies on earlier slices>

## S2: ...

## Not planned
- <useful ideas outside the handoff's scope>
\`\`\``;

export const PLAN_SLICE = { id: 'PLAN', title: 'Write the slice plan', body: '', needs: [] };

export const FINAL_SLICE = {
  id: 'FINAL',
  title: 'Final verification',
  needs: [],
  body: 'Run the project\'s required full verification on the current candidate (all slices). '
    + 'Fix failures that belong to this work, within its accepted scope. Do not start new features.',
};

// ---------- agents ----------

export function nextSlice() {
  if (!state.slices.PLAN && !fs.existsSync(ctx.plan)) return PLAN_SLICE;
  const pending = parsePlan().find((s) => state.slices[s.id]?.status !== 'done');
  if (pending) return pending;
  return state.slices.FINAL ? null : FINAL_SLICE;
}

export function sliceProgress(slice) {
  const pr = progress();
  const pos = slice.id === 'FINAL' ? 'final' : slice.id === 'PLAN' ? 'planning' : `slice ${pr.index(slice.id)}/${pr.slices}`;
  return [pos, pr.criteria ? `acceptance ${pr.criteriaMet}/${pr.criteria}` : null].filter(Boolean).join(' \u00b7 ');
}

// ---------- prerequisite slices ----------
// A slice can be set aside while a prerequisite slice runs first: either the owner chose one through the
// advisor (the relay inserts it into plan.md), or the owner added one to plan.md ahead of the current slice
// and re-ran the relay. Only an untouched slice (no commits or changes since it started) is set aside. Its
// state, including its workers' sessions, is kept; afterwards the same workers resume from the new HEAD.

// Static totals for the startup header; on a resumed run, also what is already done.
export function planSummary(pr) {
  const done = (n, word) => (n ? C.gray(` (${n} ${word})`) : '');
  return [
    `${plural(pr.slices, 'slice')}${done(pr.slicesDone, 'done')}`,
    pr.criteria ? `${pr.criteria} acceptance criteria${done(pr.criteriaMet, 'met')}` : null,
  ].filter(Boolean).join(C.gray(' \u00b7 '));
}
