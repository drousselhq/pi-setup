// pi-relay: Prerequisite slices: inserting them, setting the current slice aside and resuming it.

import fs from 'node:fs';
import { closeAgent, closeAll } from './agents.mjs';
import { C, emit, event, heading, log } from './console.mjs';
import { run } from './io.mjs';
import { parsePlan, sliceProgress } from './plan.mjs';
import { ctx, git, now, RelayStop, RUN_ID, state } from './runtime.mjs';
import { queue } from './steps.mjs';
import { save } from './store.mjs';
import { sliceBaseline, sliceChanged } from './transitions.mjs';

// Writes the owner's prerequisite slice into plan.md just before `current` and returns its id: the
// previous slice's number with the next free letter (S2 -> S2b, S2c, ...; S0 before S1).
export function insertPrerequisite(current, spec, decisionId) {
  const plan = parsePlan();
  const at = plan.findIndex((s) => s.id === current.id);
  const prev = at > 0 ? plan[at - 1].id.match(/^S(\d+)([A-Z]?)$/) : null;
  const num = prev ? prev[1] : '0';
  const taken = new Set([...plan.map((s) => s.id), ...Object.keys(state.slices), ...Object.keys(state.setAsideSlices ?? {})]);
  const candidates = [...(prev ? [] : ['']), ...'BCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !prev?.[2] || l > prev[2])];
  const letter = candidates.find((l) => !taken.has(`S${num}${l}`));
  if (letter === undefined) {
    throw new RelayStop(`No free slice id before ${current.id} for the prerequisite slice "${spec.title}" (owner decision ${decisionId}). `
      + `Add it to plan.md yourself, then re-run pi-relay ${ctx.topic}.`);
  }
  const id = `S${num}${letter.toLowerCase()}`;
  const oneLine = (x) => String(x).replace(/\s+/g, ' ').trim();
  const block = [
    `## ${id}: ${oneLine(spec.title)}`,
    'Needs: none',
    'Acceptance:',
    ...spec.acceptance.map((a) => `- ${oneLine(a)}`),
    `Notes: Prerequisite for ${current.id}, inserted by pi-relay from owner decision ${decisionId}.${spec.notes ? ` ${oneLine(spec.notes)}` : ''}`,
    '',
  ];
  const lines = fs.readFileSync(ctx.plan, 'utf8').split('\n');
  const heading = new RegExp(`^##\\s+${current.id}\\s*[:\u2014\u2013-]`, 'i');
  const where = lines.findIndex((l) => heading.test(l));
  if (where < 0) throw new RelayStop(`Could not find slice ${current.id} in ${ctx.plan} to insert the prerequisite slice before it.`);
  lines.splice(where, 0, ...block);
  fs.writeFileSync(ctx.plan, lines.join('\n'));
  const inserted = parsePlan().find((s) => s.id === id.toUpperCase());
  if (!inserted) throw new RelayStop(`The prerequisite slice ${id} written to ${ctx.plan} could not be read back.`);
  log(`${id} inserted into plan.md before ${current.id} (owner decision ${decisionId}): ${oneLine(spec.title)}`, { quiet: true });
  return inserted.id;
}

// Keeps the current slice's state (and its workers' sessions) and closes its tabs, so `before` runs first.
// `resume` is the message for the worker that continues when the slice resumes (null: keep the queued step).
export function setAside(before, resume) {
  const c = state.cur;
  closeAgent('advisor');
  c.advice = null;
  const agents = { ...c.agents };
  closeAll();
  c.agents = agents; // closed tabs; their session files are resumed later
  state.setAsideSlices = { ...state.setAsideSlices, [c.slice]: { cur: c, before, resume, at: now() } };
  emit('slice_set_aside', { slice: c.slice, before });
  log(`${c.slice} set aside: ${before} runs first; then ${c.slice} resumes with the same workers`, { quiet: true });
  event(C.yellow('\u21b7'), `${C.yellow(`${c.slice} set aside`)} ${C.dim(`\u00b7 ${before} runs first; then ${c.slice} resumes with the same workers`)}`);
  state.cur = null;
  save();
}

// The owner added an unfinished slice to plan.md ahead of the current one and re-ran the relay.
export function setAsideForEarlierSlice() {
  const c = state.cur;
  if (!c || c.slice === 'PLAN' || c.slice === 'FINAL') return;
  const plan = parsePlan();
  const at = plan.findIndex((s) => s.id === c.slice);
  const earlier = at > 0 ? plan.slice(0, at).find((s) => state.slices[s.id]?.status !== 'done') : null;
  if (!earlier) return;
  if (sliceChanged()) {
    throw new RelayStop(`plan.md now puts ${earlier.id} before the current slice ${c.slice}, but ${c.slice} already has commits `
      + 'or uncommitted changes since it started, so it cannot simply be set aside. Move the new slice after it, or deal '
      + `with ${c.slice}'s changes first, then re-run pi-relay ${ctx.topic}.`);
  }
  const p = c.pending;
  setAside(earlier.id, p ? {
    role: p.role, purpose: p.purpose,
    text: `The owner added slice ${earlier.id} to plan.md before this slice, and it has now been done. If your earlier result `
      + 'asked a question or reported a block, read decisions.md and the plan for the answer.',
  } : null);
}

// Restores a set-aside slice: same state and worker sessions, a new base at the current HEAD (the
// prerequisite's commits are not this slice's work), and the waiting worker told what was done.
export function resumeSetAside(slice) {
  const entry = state.setAsideSlices[slice.id];
  delete state.setAsideSlices[slice.id];
  const c = entry.cur;
  const done = state.slices[entry.before];
  const commits = done?.base && done.head && done.head !== done.base ? git(['log', '--format=%h %s', `${done.base}..${done.head}`]) : '';
  state.cur = { ...c, ...sliceBaseline(), baseStatus: undefined, pending: null, fresh: false, resumed: RUN_ID };
  if (entry.resume) {
    const pre = parsePlan().find((s) => s.id === entry.before);
    queue({
      role: entry.resume.role, purpose: entry.resume.purpose, initial: false,
      text: `${entry.resume.text}\n\nThe prerequisite slice ${entry.before}${pre ? ` ("${pre.title}")` : ''} is done`
        + `${commits ? `; its commits:\n${commits}` : ' (no commits)'}.\nThis slice's base is now ${state.cur.base}: `
        + 'review covers only changes made after it. Continue your current step.',
    });
  }
  emit('slice_resumed', { before: entry.before, base: state.cur.base });
  log(`${slice.id} resumed after ${entry.before}; new base ${state.cur.base}`, { quiet: true });
  heading(`${slice.id}  ${slice.title}`, `resumed after ${entry.before} \u00b7 ${sliceProgress(slice)}`);
  save();
}
