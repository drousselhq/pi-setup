// pi-relay: Acceptance tests written before implementation (`Needs: acceptance`): checking the
// acceptance worker's result, keeping the original files, and telling later workers what changed.
//
// The acceptance worker writes new test files only. The relay checks that the files it lists are
// exactly what it changed, copies them to slices/<id>/acceptance-original/ (complete or absent: copied
// to a temporary directory, then renamed), and re-baselines the slice so they do not count as the
// slice's changes. It never runs them and never blocks on them: it reports changed or missing files to
// the reviewer, to the worker that resumes a set-aside slice, and lists them as "not this work" for a
// prerequisite slice that runs while they sit in the working tree.

import fs from 'node:fs';
import path from 'node:path';
import { changedFiles, sliceBaseline } from './changes.mjs';
import { emit } from './console.mjs';
import { ctx, git, io, state } from './runtime.mjs';
import { artifactPath, sliceDir } from './steps.mjs';

export const PREP_ORDER = ['scout', 'architect', 'acceptance'];

const snapshotDir = (sliceId) => path.join(sliceDir(sliceId), 'acceptance-original');

// The acceptance worker's step. Queuing it records what already differed, so its own changes can be told apart.
export function acceptanceStep(slice) {
  startAcceptance(slice.id);
  return { role: 'acceptance', purpose: 'prep', initial: true, text: `Write the acceptance tests for slice ${slice.id} from its `
    + 'requirement sources, before implementation. Write new files only and list every file you created in "tests".' };
}

// Recorded when the acceptance step is queued: what already differed, so its own changes can be told apart.
// Also removes a snapshot left by an earlier attempt, so the one found after the result is this step's.
export function startAcceptance(sliceId) {
  fs.rmSync(snapshotDir(sliceId), { recursive: true, force: true });
  state.cur.acceptanceStart = { head: git(['rev-parse', 'HEAD']), files: changedFiles() };
}

// The project-relative form of a listed path, or null when it is not a usable path.
function relative(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = path.resolve(ctx.project, p.trim());
  const rel = path.relative(ctx.project, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
}

// Why an acceptance result with status "done" is not acceptable, or null when it is.
export function acceptanceProblem(r) {
  const start = state.cur?.acceptanceStart;
  if (!start?.files) return 'the relay could not record the working tree when your step started; report "blocked"';
  if (!Array.isArray(r.tests) || !r.tests.length) return '"tests" must list every file you created (at least one)';
  const rels = r.tests.map(relative);
  const bad = r.tests.filter((_, i) => rels[i] === null);
  if (bad.length) return `"tests" has paths outside the project or unusable: ${bad.map((x) => JSON.stringify(x)).join(', ')}`;
  if (new Set(rels).size !== rels.length) return '"tests" lists a file twice';
  const realProject = fs.realpathSync(ctx.project);
  for (const rel of rels) {
    if (/^(\.agents_work|\.git)(\/|$)/.test(rel)) return `${rel} is a relay record or Git metadata, not a test file`;
    const abs = path.join(ctx.project, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { return `${rel} does not exist`; }
    if (!st.isFile()) return `${rel} is not a regular file`;
    const real = fs.realpathSync(abs);
    if (real !== realProject && !real.startsWith(`${realProject}${path.sep}`)) return `${rel} resolves outside the project`;
    try { fs.accessSync(abs, fs.constants.R_OK); } catch { return `${rel} is not readable`; }
    if (io.git(['check-ignore', '-q', '--', rel], ctx.project).status === 0) return `${rel} is ignored by Git`;
    const inHead = io.git(['cat-file', '-e', `HEAD:${rel}`], ctx.project).status === 0;
    if (inHead || start.files[rel] !== undefined) return `${rel} existed before your step: write new files only`;
  }
  if (git(['rev-parse', 'HEAD']) !== start.head) return 'HEAD moved during your step: do not commit';
  const now = changedFiles();
  if (!now) return 'Git could not list the working tree changes';
  const touched = [...new Set([...Object.keys(start.files), ...Object.keys(now)])].filter((f) => start.files[f] !== now[f]);
  const unlisted = touched.filter((f) => !rels.includes(f));
  if (unlisted.length) return `you changed files you did not list (new files only, all listed in "tests"): ${unlisted.join(', ')}`;
  return null;
}

// After a valid result: keep the originals, record them and re-baseline the slice. On a replayed
// transition the complete snapshot from the first attempt is kept, never recopied from a later tree.
export function recordAcceptance(sliceId, r) {
  const tests = r.tests.map(relative);
  const dir = snapshotDir(sliceId);
  if (!fs.existsSync(dir)) {
    const tmp = `${dir}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const rel of tests) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(ctx.project, rel), path.join(tmp, rel));
    }
    fs.renameSync(tmp, dir);
  }
  const baseline = sliceBaseline(); // before changing state: if it fails, the replay still validates the result
  state.cur.acceptance = { tests, snapshot: dir, record: artifactPath('acceptance', sliceId) };
  delete state.cur.acceptanceStart;
  Object.assign(state.cur, baseline);
  emit('acceptance_recorded', { tests, snapshot: dir });
}

// Acceptance files that differ from their originals, and those that are gone.
export function acceptanceChanges(acc) {
  const changed = [];
  const missing = [];
  for (const rel of acc.tests) {
    const file = path.join(ctx.project, rel);
    if (!fs.existsSync(file)) { missing.push(rel); continue; }
    let original;
    try { original = fs.readFileSync(path.join(acc.snapshot, rel)); } catch { missing.push(`${rel} (original copy missing)`); continue; }
    if (!fs.readFileSync(file).equals(original)) changed.push(rel);
  }
  return { changed, missing };
}

const describe = ({ changed, missing }) => [
  changed.length ? `changed since they were written: ${changed.join(', ')}` : '',
  missing.length ? `missing: ${missing.join(', ')}` : '',
].filter(Boolean).join('; ') || 'unchanged since they were written';

// For the implementer's first step.
export function implementerNote() {
  const acc = state.cur?.acceptance;
  if (!acc) return '';
  return `\n\nAcceptance tests for this slice were written from its requirement sources before implementation: `
    + `${acc.tests.join(', ')} (record: ${acc.record}). They are part of this slice's work: adapt their binding (names, `
    + 'signatures, fixture paths) to the real interface where needed, never an expected result, and record each change. '
    + 'Commit them with your work when you commit.';
}

// For every review and re-review message.
export function reviewerNote() {
  const acc = state.cur?.acceptance;
  if (!acc) return '';
  const changes = acceptanceChanges(acc);
  emit('acceptance_compared', changes);
  return `\n\nAcceptance tests written before implementation: ${acc.tests.join(', ')}; record ${acc.record}; originals in `
    + `${acc.snapshot}. Relay comparison: ${describe(changes)}.`
    + ' Read the record first, run these tests on the candidate, and compare every changed file with its original: '
    + 'each changed expectation is a finding.';
}

// For every assignment while slices with acceptance tests are set aside.
export function setAsideNote() {
  const lines = Object.entries(state.setAsideSlices ?? {})
    .filter(([, e]) => e.cur?.acceptance)
    .map(([id, e]) => `Acceptance tests of set-aside slice ${id}: ${e.cur.acceptance.tests.join(', ')}. Never stage, edit, delete `
      + 'or make them pass. If they break your build or test discovery, exclude them from your checks and say so in your record.');
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

// When a set-aside slice resumes: tell the worker that continues if its acceptance files changed meanwhile.
export function resumeNote(role) {
  const acc = state.cur?.acceptance;
  if (!acc || !role) return;
  const changes = acceptanceChanges(acc);
  if (!changes.changed.length && !changes.missing.length) return;
  state.cur.notes = state.cur.notes ?? {};
  state.cur.notes[role] = [state.cur.notes[role], `While this slice was set aside, its acceptance tests were `
    + `${describe(changes)}. Compare them with the originals in ${acc.snapshot} before continuing.`].filter(Boolean).join('\n\n');
}
