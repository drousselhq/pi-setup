// pi-relay: Topic paths, configuration, the state file and the run lock.

import fs from 'node:fs';
import path from 'node:path';
import { cfg, ctx, git, io, readJson, RELAY_HOME, RelayStop, setCfg, setState, state } from './runtime.mjs';

export function setup(topic) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(topic) || topic === 'archives') {
    throw new RelayStop(`Invalid topic name: ${topic}`);
  }
  const top = io.git(['rev-parse', '--show-toplevel'], io.cwd());
  ctx.project = top.status === 0 ? top.stdout.trim() : io.cwd();
  ctx.topic = topic;
  ctx.slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  ctx.topicDir = path.join(ctx.project, '.agents_work', topic);
  ctx.relayDir = path.join(ctx.topicDir, 'relay');
  ctx.handoff = path.join(ctx.topicDir, 'handoff.md');
  ctx.plan = path.join(ctx.topicDir, 'plan.md');
  ctx.decisions = path.join(ctx.topicDir, 'decisions.md');
  ctx.stateFile = path.join(ctx.relayDir, 'state.json');
  ctx.logFile = path.join(ctx.relayDir, 'log.md');
  if (!fs.existsSync(ctx.handoff) && !fs.existsSync(ctx.plan)) {
    throw new RelayStop(`Neither ${ctx.handoff} nor ${ctx.plan} exists. Write a handoff first (/handoff).`);
  }
  fs.mkdirSync(ctx.relayDir, { recursive: true });

  const global = readJson(path.join(io.relayHome ?? RELAY_HOME, 'config.json'), {});
  const local = readJson(path.join(ctx.topicDir, 'relay.json'), {});
  // Roles and the council block merge field by field; other settings are replaced whole.
  setCfg({ ...global, ...local, roles: { ...global.roles }, council: { ...global.council, ...local.council } });
  for (const [role, v] of Object.entries(local.roles ?? {})) cfg.roles[role] = { ...cfg.roles[role], ...v };
  // The acceptance worker defaults to the topic's resolved reviewer model; set fields override it.
  if (cfg.roles.reviewer) cfg.roles.acceptance = { ...cfg.roles.reviewer, ...cfg.roles.acceptance };

  loadState();
}

// Reads state.json (again after taking the lock: another relay may have written it meanwhile).
export function loadState() {
  setState(readJson(ctx.stateFile, { seq: 0, slices: {}, cur: null, sessions: [] }));
  if (state.startStatus === undefined) {
    state.startStatus = git(['status', '--porcelain']) ?? '';
    state.startHead = git(['rev-parse', 'HEAD']);
  }
}

export function save() {
  writeFileAtomic(ctx.stateFile, JSON.stringify(state, null, 2));
}

// Files that carry obligations (state, decisions, a relay-inserted plan slice) are replaced whole: a failed
// write leaves the previous version.
export function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Only the relay holding the lock writes the topic's state, log and events (see runRelay()). The lock
// file is created exclusively; a lock left by a relay that is no longer running is replaced once, and
// so is one that stayed empty or unreadable (a relay killed while writing it) for more than a minute.
// (Two relays replacing the same stale lock at the same moment can still both start: not guarded.)
const UNWRITTEN_LOCK_MS = 60_000;

export function acquireLock() {
  const lock = path.join(ctx.relayDir, 'lock');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lock, String(io.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let text = null;
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
      text = fs.readFileSync(lock, 'utf8').trim();
    } catch { /* removed meanwhile: try again */ }
    const pid = /^\d+$/.test(text ?? '') ? Number(text) : null;
    const live = text !== null && (pid ? io.processAlive(pid) : age < UNWRITTEN_LOCK_MS);
    if (attempt > 0 || live) {
      throw new RelayStop(`Another relay${pid ? ` (pid ${pid})` : ''} is running this topic. If none is, `
        + `delete ${path.relative(ctx.project, lock)} and start pi-relay ${ctx.topic} again.`);
    }
    if (text !== null) fs.rmSync(lock, { force: true }); // left by a relay that is no longer running
  }
  ctx.locked = true;
  io.onExit(() => {
    try { if (fs.readFileSync(lock, 'utf8') === String(io.pid)) fs.unlinkSync(lock); } catch { /* gone */ }
  });
}

// ---------- plan ----------
