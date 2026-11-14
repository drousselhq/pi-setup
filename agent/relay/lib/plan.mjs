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

const SLICE_HEADING = /^##\s+(S\d+[a-z]?)\s*[:—–-]\s*(.+?)\s*$/i;
const NEEDS_LINE = /^\W*needs\W*:\s*(.*)$/i;
const PREP_NEEDS = ['scout', 'architecture', 'acceptance'];
// The values of a Needs: line, without surrounding punctuation or emphasis: one reading for checking and running.
const needsTokens = (text) => text.split(/[,\s]+/).map((x) => x.replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean);

export function parsePlan() {
  if (!fs.existsSync(ctx.plan)) return [];
  const slices = [];
  let cur = null;
  for (const line of fs.readFileSync(ctx.plan, 'utf8').split('\n')) {
    const m = line.match(SLICE_HEADING);
    if (m) {
      cur = { id: m[1].toUpperCase(), title: m[2], lines: [line], needs: [], acceptance: 0, inAcceptance: false };
      slices.push(cur);
    } else if (/^#{1,2}\s/.test(line)) {
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
      const n = line.match(NEEDS_LINE);
      if (n) cur.needs = needsTokens(n[1].toLowerCase()).filter((x) => PREP_NEEDS.includes(x));
      // Acceptance criteria: the bullets under "Acceptance:" (or one inline criterion after the colon). The heading may
      // carry a note in brackets ("Acceptance (narrowed by council decision D40):").
      const a = line.match(/^\W*acceptance\b(?:\s*\([^)]*\))?\W*:\s*(.*)$/i);
      if (a) { cur.inAcceptance = true; if (a[1].replace(/[\s*_]/g, '')) cur.acceptance++; } // "**Acceptance:**" leaves only "**"
      else if (cur.inAcceptance && /^\s*([-*+]|\d+[.)])\s+\S/.test(line)) cur.acceptance++;
      else if (cur.inAcceptance && line.trim() && !/^\s{2,}\S/.test(line)) cur.inAcceptance = false;
    }
  }
  const ids = slices.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new RelayStop(`plan.md defines slice ${dup} twice.`);
  return slices.map(({ inAcceptance, ...s }) => ({ ...s, body: s.lines.join('\n').trim() }));
}

// What in plan.md would make the relay silently skip work or preparation: no slices, a heading meant as a
// slice that does not parse, or a Needs: value it does not know. Earlier slices may be named in Needs: (S1,
// S2a, S2–S6) to document order; slices still run in file order. Returns problems naming their line.
// A missing plan is a problem only once it is `required` (after planning); before, the planner writes it.
export function planProblems({ required }) {
  if (!fs.existsSync(ctx.plan)) return required ? [`${ctx.plan} does not exist`] : [];
  const problems = [];
  const ids = [];
  let inSlice = false;
  fs.readFileSync(ctx.plan, 'utf8').split('\n').forEach((line, i) => {
    const heading = line.match(SLICE_HEADING);
    if (heading) { ids.push(heading[1].toUpperCase()); inSlice = true; return; }
    if (/^#{1,2}\s/.test(line)) {
      inSlice = false;
      if (/^##\s+(S\d|slice\b|step\b)/i.test(line)) problems.push(`line ${i + 1} "${line.trim()}" looks like a slice heading but is not "## S<n>: title"`);
      return;
    }
    const needs = inSlice && line.match(NEEDS_LINE);
    if (!needs) return;
    const earlier = ids.slice(0, -1);
    const tokens = needsTokens(needs[1]);
    if (!tokens.length) problems.push(`line ${i + 1} (slice ${ids.at(-1)}): Needs has no value (write "none")`);
    for (const token of tokens) {
      if (['none', 'nothing', ...PREP_NEEDS].includes(token.toLowerCase())) continue;
      const range = token.match(/^(S\d+[a-z]?)(?:[–—-](S\d+[a-z]?))?$/i);
      const ends = range ? [range[1], range[2]].filter(Boolean).map((x) => x.toUpperCase()) : [];
      if (!range || !ends.every((x) => earlier.includes(x))) {
        problems.push(`line ${i + 1} (slice ${ids.at(-1)}): Needs "${token}" is not ${['none', ...PREP_NEEDS].join(', ')} or an earlier slice`);
      }
    }
  });
  if (!ids.length) problems.unshift(`${ctx.plan} has no slices ("## S1: title" headings)`);
  return problems;
}

export function checkPlan(context = 'plan.md', required = Boolean(state.slices.PLAN)) {
  const problems = planProblems({ required });
  if (problems.length) {
    throw new RelayStop(`${context} cannot be used as written: ${problems.slice(0, 5).join('; ')}`
      + `${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}. Fix ${ctx.plan}, then start pi-relay ${ctx.topic} again.`);
  }
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

## S2: <slice title>
Needs: S1
Acceptance:
- <observable condition>

## Not planned
- <useful ideas outside the handoff's scope>
\`\`\``;

export const PLAN_SLICE = { id: 'PLAN', title: 'Write the slice plan', body: '', needs: [] };

export const FINAL_SLICE = {
  id: 'FINAL',
  title: 'Final verification',
  needs: [],
  body: 'Run the project\'s required full verification on the current candidate (all slices). '
    + 'Fix failures that belong to this work, within its accepted scope. Do not start new features. '
    + 'Report the outcome in "verification": "pass" only if the full verification passed on the candidate as you leave it, else "fail". '
    + 'Weakening a verification gate (anything that makes it check less than before: a looser threshold, limit, tolerance '
    + 'or coverage floor; code, tests or cases excluded, removed or moved out of its reach or to a weaker level; a check '
    + 'skipped, made optional or replaced with a weaker one) that the handoff, a slice or a decision does not authorise needs '
    + 'a decision (status needs-decision), whatever the reason for it. Unless the project\'s rules say otherwise, genuinely '
    + 'new code under the existing requirements, the same requirements kept across a path change, or a tightened gate is '
    + 'not weakening; judge each affected requirement separately.',
};

// ---------- slice order ----------

// The plan's size for the records, or null when there is no readable plan (a measurement never stops a run).
export function planSize() {
  try {
    const slices = parsePlan();
    return slices.length ? { slices: slices.length, acceptance: slices.reduce((n, s) => n + s.acceptance, 0) } : null;
  } catch {
    return null;
  }
}

export function nextSlice() {
  if (!state.slices.PLAN && !fs.existsSync(ctx.plan)) return PLAN_SLICE;
  checkPlan(); // plan.md may have been edited since the run started
  const pending = parsePlan().find((s) => state.slices[s.id]?.status !== 'done');
  if (pending) return pending;
  return state.slices.FINAL ? null : FINAL_SLICE;
}

export function sliceProgress(slice) {
  const pr = progress();
  const pos = slice.id === 'FINAL' ? 'final' : slice.id === 'PLAN' ? 'planning' : `slice ${pr.index(slice.id)}/${pr.slices}`;
  return [pos, pr.criteria ? `acceptance ${pr.criteriaMet}/${pr.criteria}` : null].filter(Boolean).join(' \u00b7 ');
}

// Static totals for the startup header; on a resumed run, also what is already done.
export function planSummary(pr) {
  const done = (n, word) => (n ? C.gray(` (${n} ${word})`) : '');
  return [
    `${plural(pr.slices, 'slice')}${done(pr.slicesDone, 'done')}`,
    pr.criteria ? `${pr.criteria} acceptance criteria${done(pr.criteriaMet, 'met')}` : null,
  ].filter(Boolean).join(C.gray(' \u00b7 '));
}
