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
// A stale lock is removed only under an exclusively created guard (lock.reclaim), after reading it again:
// two relays reclaiming it at the same moment cannot both start, nor remove each other's new lock.
const UNWRITTEN_LOCK_MS = 60_000;
const YOUNG_GUARD_MS = 5_000;

// A lock or guard file: its text, age, pid and identity (inode and time: the same text can be another file).
function readLockFile(file) {
  try {
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8').trim();
    return { text, age: Date.now() - st.mtimeMs, pid: /^\d+$/.test(text) ? Number(text) : null, id: `${st.ino}:${st.mtimeMs}` };
  } catch { return { text: null, age: 0, pid: null, id: null }; } // removed meanwhile
}

export function acquireLock() {
  const lock = path.join(ctx.relayDir, 'lock');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lock, String(io.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const held = readLockFile(lock);
    const live = held.text !== null && (held.pid ? io.processAlive(held.pid) : held.age < UNWRITTEN_LOCK_MS);
    if (attempt > 0 || live) {
      throw new RelayStop(`Another relay${held.pid ? ` (pid ${held.pid})` : ''} is running this topic. If none is, `
        + `delete ${path.relative(ctx.project, lock)} and start pi-relay ${ctx.topic} again.`);
    }
    if (held.text !== null && reclaimStale(lock, held)) break; // left by a relay that is no longer running
  }
  removeOrphanGuard(`${lock}.reclaim`);
  ctx.locked = true;
  io.onExit(() => {
    try { if (fs.readFileSync(lock, 'utf8') === String(io.pid)) fs.unlinkSync(lock); } catch { /* gone */ }
  });
}

// Holding the guard, removes the stale lock `held` if it is still the very same file and creates this relay's lock;
// returns whether it holds the lock (false: another relay was faster). A guard left by a relay killed while holding
// it cannot be told from one in use without reopening the race: after a short wait for a young one, the relay stops
// and names it (the owner deletes it).
function reclaimStale(lock, held) {
  const guard = `${lock}.reclaim`;
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(guard, String(io.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const g = readLockFile(guard);
    if (g.text === null && i < 10) continue; // released meanwhile (or unreadable: bounded)
    if (g.age < YOUNG_GUARD_MS && i < 10) { io.sleep(500); continue; } // another relay is taking the lock over
    if (g.pid && io.processAlive(g.pid)) throw new RelayStop(`Another relay (pid ${g.pid}) is starting this topic.`);
    throw new RelayStop(`No relay is running this topic, but one was killed while taking over its lock. Delete `
      + `${path.relative(ctx.project, guard)} and start pi-relay ${ctx.topic} again.`);
  }
  try {
    if (readLockFile(lock).id === held.id) fs.rmSync(lock, { force: true }); // still the same stale lock file
    try {
      fs.writeFileSync(lock, String(io.pid), { flag: 'wx' }); // created and written before the guard is released
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      return false;
    }
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

// A guard left by a relay killed after it removed the stale lock (the lock was then free): once this relay holds the
// lock, a guard whose relay is gone is removed, so it cannot block a later takeover.
function removeOrphanGuard(guard) {
  const g = readLockFile(guard);
  if (g.text === null) return;
  if (g.pid ? !io.processAlive(g.pid) : g.age >= YOUNG_GUARD_MS) fs.rmSync(guard, { force: true });
}

// ---------- plan ----------
