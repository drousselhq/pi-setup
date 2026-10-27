// pi-relay: Shared run state, protocol constants and the thin wrappers around io (Herdr, Git, notifications).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The relay's own directory (config.json, usage-cache.json): the parent of lib/.
export const RELAY_HOME = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));

export const HUMAN_STATUSES = new Set(['needs-decision', 'blocked']);

export const HELP_STATUSES = { 'needs-scout': 'scout', 'needs-architecture': 'architect' };

export const TEMPLATE = { planner: 'plan', scout: 'scout', architect: 'architecture', implementer: 'implement', senior: 'implement', reviewer: 'review', advisor: 'advise' };

export const STATUSES = {
  planner: ['done', 'needs-decision', 'blocked'],
  scout: ['done', 'needs-decision', 'blocked'],
  architect: ['done', 'needs-decision', 'blocked'],
  implementer: ['done', 'needs-scout', 'needs-architecture', 'needs-decision', 'blocked'],
  senior: ['done', 'needs-scout', 'needs-architecture', 'needs-decision', 'blocked'],
  advisor: ['needs-decision', 'done', 'blocked'],
  reviewer: ['done', 'needs-architecture', 'needs-decision', 'blocked'],
};

export class RelayStop extends Error {}

// ---------- the outside world ----------
// Everything the relay does outside its own files goes through `io`: Herdr, Git, notifications, the
// terminal, waiting, the quota endpoint and process facts. Tests replace it (see test/relay/).

export let io; // set by runRelay() (the real io, or a test double)

export function setIo(value) { io = value; }

export const sleep = (ms) => io.sleep(ms);

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function herdr(args, { allowFail = false } = {}) {
  const r = io.herdr(args);
  let json = null;
  for (const out of [r.stdout, r.stderr]) {
    try { json = JSON.parse(out); break; } catch { /* try the other stream */ }
  }
  if (json && !json.error) return json.result;
  const error = json?.error ?? { code: 'unparsed', message: (r.stderr || r.stdout).trim() };
  if (allowFail) return { error };
  throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${error.code}: ${error.message}`);
}

export function git(args) {
  const r = io.git(args, ctx.project);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function notify(title, body) {
  io.write('\x07');
  herdr(['notification', 'show', title, '--body', body, '--sound', 'request'], { allowFail: true });
  io.notify(title, body);
}

// ---------- console output ----------
// The console is for a human watching the run; relay/log.md keeps the same events as plain text.

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const ctx = {};

export let cfg;

export let state;

export function setCfg(value) { cfg = value; }

export function setState(value) { state = value; }

export function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export let RUN_ID = null; // set at the start of main()

export function setRunId(value) { RUN_ID = value; }
