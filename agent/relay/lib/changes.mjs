// pi-relay: Change detection: whether a slice changed anything since its base.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ctx, git, io, state } from './runtime.mjs';

// Whether a slice changed anything is decided by content, not by `git status`: with commit: false a
// file that is already modified stays " M file" however often it changes. The fingerprint covers HEAD,
// the working-tree content of every file that differs from HEAD (staged or not) and of untracked files,
// and leaves out .agents_work/ (relay and worker records are not product changes). Git lists only the
// paths; the relay hashes the files itself in chunks, so a large change never passes through a buffer.
// If Git cannot list the paths, the fingerprint is unique: the slice counts as changed (the cautious side).

const OUTSIDE_RECORDS = ['--', '.', ':(exclude).agents_work'];

export function hashPath(h, rel) {
  const file = path.join(ctx.project, rel);
  h.update(`\0${rel}\0`);
  let st;
  try { st = fs.lstatSync(file); } catch { return h.update('missing'); }
  if (st.isSymbolicLink()) return h.update(`link ${fs.readlinkSync(file)}`);
  if (!st.isFile()) return h.update('not a file');
  h.update(st.mode & 0o111 ? 'exec\0' : 'file\0');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
}

// The paths that differ from HEAD (staged or not) and the untracked ones, outside .agents_work/, sorted;
// null when Git cannot list them.
export function changedPaths(head = git(['rev-parse', '--verify', '--quiet', 'HEAD'])) {
  const changed = head ? git(['diff', 'HEAD', '--name-only', '--no-renames', '-z', ...OUTSIDE_RECORDS]) : git(['ls-files', '-z', ...OUTSIDE_RECORDS]);
  const untracked = git(['ls-files', '-o', '--exclude-standard', '-z', ...OUTSIDE_RECORDS]);
  if (changed === null || untracked === null) return null;
  return [...new Set(`${changed}\0${untracked}`.split('\0').filter(Boolean))].sort();
}

export function workFingerprint() {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const paths = changedPaths(head);
  if (paths === null) return `unknown ${Date.now()} ${Math.random()}`;
  const h = createHash('sha256');
  h.update(`head ${head}\n`);
  for (const rel of paths) {
    try { hashPath(h, rel); } catch { h.update('unreadable'); }
  }
  return h.digest('hex');
}

// The point a slice's changes are measured from: when it starts, and when it resumes after being set aside.
export const sliceBaseline = () => ({ base: git(['rev-parse', 'HEAD']), baseContent: workFingerprint() });

export function sliceChanged() {
  const c = state.cur;
  if (git(['rev-parse', 'HEAD']) !== c.base) return true;
  if (c.baseContent !== undefined) return workFingerprint() !== c.baseContent;
  return (git(['status', '--porcelain']) ?? '') !== (c.baseStatus ?? ''); // a slice started by an older relay
}

// The candidate as content, for the final verification: the Git tree of the working tree's tracked and untracked,
// non-ignored files outside .agents_work/ (taken out explicitly: projects need not ignore it), built in a temporary
// copy of the index (unchanged files are not read again; flags that make Git skip a file's content, assume-
// unchanged and skip-worktree, are cleared in the copy). Committing verified content leaves it unchanged; any
// content change alters it. Null when Git cannot build it.
export function candidateTree() {
  // In .git, outside the working tree (adding the working tree never takes the index file itself), one per process.
  const temp = git(['rev-parse', '--git-path', `pi-relay-candidate-${io.pid}.index`]);
  const real = git(['rev-parse', '--git-path', 'index']);
  if (temp === null) return null;
  const index = path.resolve(ctx.project, temp);
  try {
    const realIndex = real === null ? null : path.resolve(ctx.project, real);
    if (realIndex && fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index);
    else fs.rmSync(index, { force: true });
    const env = { GIT_INDEX_FILE: index };
    const listed = git(['ls-files', '-v', '-z'], env);
    if (listed === null) return null;
    const flagged = listed.split('\0').filter((e) => /^[a-zS] /.test(e)).map((e) => e.slice(2));
    // One flag per command: given both, Git clears only assume-unchanged.
    for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {
      for (let i = 0; i < flagged.length; i += 200) {
        if (git(['update-index', flag, '--', ...flagged.slice(i, i + 200)], env) === null) return null;
      }
    }
    // .agents_work/ is taken out of the temporary index rather than excluded by pathspec: Git refuses a pathspec
    // that names an ignored path, and projects may or may not ignore it.
    if (git(['add', '-A'], env) === null) return null;
    if (git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.agents_work'], env) === null) return null;
    return git(['write-tree'], env);
  } finally {
    fs.rmSync(index, { force: true });
  }
}
