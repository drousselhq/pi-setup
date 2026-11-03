// pi-relay: Change detection: whether a slice changed anything since its base.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ctx, git, state } from './runtime.mjs';

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
