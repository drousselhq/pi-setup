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
  setCfg({ ...global, ...local, roles: { ...global.roles } });
  for (const [role, v] of Object.entries(local.roles ?? {})) cfg.roles[role] = { ...cfg.roles[role], ...v };

  setState(readJson(ctx.stateFile, { seq: 0, slices: {}, cur: null, sessions: [] }));
  if (state.startStatus === undefined) {
    state.startStatus = git(['status', '--porcelain']) ?? '';
    state.startHead = git(['rev-parse', 'HEAD']);
  }
}

export function save() {
  const tmp = `${ctx.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, ctx.stateFile);
}

export function acquireLock() {
  const lock = path.join(ctx.relayDir, 'lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (io.processAlive(pid)) throw new RelayStop(`Another relay (pid ${pid}) is running this topic.`);
  }
  fs.writeFileSync(lock, String(io.pid));
  io.onExit(() => {
    try { if (fs.readFileSync(lock, 'utf8') === String(io.pid)) fs.unlinkSync(lock); } catch { /* gone */ }
  });
}

// ---------- plan ----------
