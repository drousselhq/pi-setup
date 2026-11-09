// Deterministic harness for pi-relay: a real Git repository, real plan/state/result files and the real
// relay code, with Herdr, time, notifications and the terminal replaced by an in-process fake.
//
// A test gives a `worker(call)` function. The fake calls it whenever the relay prompts an agent; it plays
// that agent (and the owner) by writing result files and committing. `call.later(fn)` runs `fn` at the
// relay's next wait, which is how the owner answers a question after the relay starts waiting.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRelay } from '../../agent/relay/pi-relay.mjs';

export const TOPIC = 'tt';

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

export const PLAN_TWO = `# Plan: test

## S1: First
Needs: none
Acceptance:
- one.txt exists

## S2: Second
Needs: none
Acceptance:
- two.txt exists
`;

const BASE_CONFIG = {
  roles: Object.fromEntries(['planner', 'scout', 'architect', 'implementer', 'senior', 'reviewer', 'advisor']
    .map((r) => [r, { model: `test/${r}`, thinking: 'low' }])),
  commit: true, maxRepairCycles: 3, maxHelpRequests: 2, maxCompactionsPerStep: 2,
  quota: { enabled: false },
  escalation: { enabled: true, afterLoops: 2, onRecurringFinding: true, maxLoops: 2 },
  advisor: { enabled: true },
};

// A fresh project: Git repository with one commit, topic folder with handoff and (optionally) plan.
export function makeProject({ plan = PLAN_TWO, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-test-'));
  const project = path.join(root, 'project');
  const relayHome = path.join(root, 'relay-home');
  const topicDir = path.join(project, '.agents_work', TOPIC);
  fs.mkdirSync(topicDir, { recursive: true });
  fs.mkdirSync(relayHome);
  sh(['init', '-q'], project);
  sh(['config', 'user.email', 't@t'], project);
  sh(['config', 'user.name', 'test'], project);
  fs.writeFileSync(path.join(project, 'README.md'), 'test\n');
  sh(['add', 'README.md'], project);
  sh(['commit', '-q', '-m', 'init'], project);
  fs.appendFileSync(path.join(project, '.git', 'info', 'exclude'), '.agents_work/\n');
  fs.writeFileSync(path.join(topicDir, 'handoff.md'), '# Handoff\n\nTest work.\n');
  if (plan) fs.writeFileSync(path.join(topicDir, 'plan.md'), plan);
  fs.writeFileSync(path.join(relayHome, 'config.json'), JSON.stringify({ ...BASE_CONFIG, ...config }, null, 2));
  return {
    root, project, relayHome, topicDir,
    relayDir: path.join(topicDir, 'relay'),
    file: (rel) => path.join(topicDir, rel),
    read: (rel) => fs.readFileSync(path.join(topicDir, rel), 'utf8'),
    state: () => JSON.parse(fs.readFileSync(path.join(topicDir, 'relay', 'state.json'), 'utf8')),
    events: () => fs.readFileSync(path.join(topicDir, 'relay', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
    log: () => fs.readFileSync(path.join(topicDir, 'relay', 'log.md'), 'utf8'),
    git: (...args) => sh(args, project),
    commit(file, content = file, message = `add ${file}`) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.writeFileSync(path.join(project, file), content);
      sh(['add', file], project);
      sh(['commit', '-q', '-m', message], project);
    },
  };
}

export class StopRelay extends Error {} // thrown by a worker to simulate the owner pressing Ctrl-C

// Fake Herdr plus the rest of `io`. One instance can serve several runs of the same project, like the
// real Herdr session would (agents stay alive across a relay restart until their tab is closed).
export class FakeHerdr {
  constructor(p, worker) {
    this.p = p;
    this.worker = worker;
    this.tabs = 0;
    this.agents = new Map(); // name -> { tab, alive, session, role }
    this.prompts = []; // { name, role, slice, text, resultPath }
    this.starts = []; // { name, role, session, resumed }
    this.pending = []; // functions to run at the next sleep
    this.counts = {};
    this.pidSeq = 1000;
    this.output = '';
    this.idleSleeps = 0;
    this.ioExtra = {}; // per-test overrides of io fields
  }

  io() {
    const pid = ++this.pidSeq;
    return {
      herdr: (args) => this.handle(args),
      git: (args, cwd, env) => spawnSync('git', args, { cwd, encoding: 'utf8', ...(env ? { env: { ...process.env, ...env } } : {}) }),
      sleep: () => {
        // A relay waiting with nothing scheduled would wait forever: fail the test instead of hanging it.
        if (++this.idleSleeps > 200) throw new Error('harness: the relay is waiting for something that will never happen');
        const due = this.pending.splice(0);
        if (due.length) this.idleSleeps = 0;
        for (const fn of due) fn();
      },
      notify: () => {},
      write: (t) => { this.output += t; },
      isTTY: () => false,
      columns: () => 100,
      env: { HERDR_ENV: '1' },
      cwd: () => this.p.project,
      pid,
      processAlive: () => false, // a previous run of the test is never alive
      onExit: () => {},
      fetchUsage: () => ({ status: 0 }),
      relayHome: this.p.relayHome,
      ...this.ioExtra,
    };
  }

  run(args = [TOPIC]) { return runRelay(args, this.io()); }

  ok(result) { return { status: 0, stdout: JSON.stringify({ result }), stderr: '' }; }
  err(code, message) { return { status: 1, stdout: JSON.stringify({ error: { code, message } }), stderr: '' }; }

  handle(a) {
    const [group, cmd, name] = a;
    if (group === 'pane' && cmd === 'current') return this.ok({ pane: { workspace_id: 'w1' } });
    if (group === 'notification') return this.ok({});
    if (group === 'tab' && cmd === 'create') { const n = ++this.tabs; return this.ok({ tab: { tab_id: `t${n}` }, root_pane: { pane_id: `p${n}` } }); }
    if (group === 'tab' && cmd === 'close') {
      for (const ag of this.agents.values()) if (ag.tab === name) ag.alive = false;
      return this.ok({});
    }
    if (group !== 'agent') return this.err('unknown', a.join(' '));
    if (cmd === 'start') {
      const live = this.agents.get(name);
      if (live?.alive) return this.err('agent_name_taken', `agent name ${name} is already used`);
      const pane = a[a.indexOf('--pane') + 1];
      const i = a.indexOf('--session');
      const session = i > 0 ? a[i + 1] : path.join(this.p.root, 'sessions', `${name}.jsonl`);
      fs.mkdirSync(path.dirname(session), { recursive: true });
      if (!fs.existsSync(session)) fs.writeFileSync(session, '');
      const role = name.split('-').at(-2);
      this.agents.set(name, { tab: `t${pane.slice(1)}`, alive: true, session, role });
      this.starts.push({ name, role, session, resumed: i > 0 });
      return this.ok({ agent: { agent_session: { value: session } } });
    }
    const ag = this.agents.get(name);
    if (!ag?.alive) return this.err('agent_not_found', `no agent ${name}`);
    if (cmd === 'wait') {
      // Fake agents are idle between prompts: a wait for another status times out, as in Herdr.
      const until = a.flatMap((x, i) => (x === '--until' ? [a[i + 1]] : []));
      if (until.length && !until.some((u) => u === 'idle' || u === 'done')) return this.err('timeout', `${name} stayed idle`);
      return this.ok({ agent: { agent_status: 'idle' } });
    }
    if (cmd === 'get' || cmd === 'send-keys') return this.ok({ agent: { agent_status: 'idle' } });
    if (cmd === 'prompt') {
      const text = a[3];
      const resultPath = (text.match(/\S+\.result\.json/g) ?? []).at(-1);
      const slice = this.p.state().cur?.slice;
      const key = `${ag.role}:${slice}`;
      const n = (this.counts[key] = (this.counts[key] ?? 0) + 1);
      const assignmentPath = text.match(/relay assignment at (\S+)/)?.[1]
        ?? text.match(/Your assignment is still (\S+?)\.? /)?.[1];
      const call = {
        name, role: ag.role, slice, text, resultPath, n, session: ag.session,
        assignment: () => fs.readFileSync(assignmentPath, 'utf8'),
      };
      this.prompts.push(call);
      this.worker({
        ...call,
        p: this.p,
        write: (obj) => writeResult(resultPath, obj),
        later: (fn) => this.pending.push(fn),
        // The owner's answer arrives after the brief: give it a later mtime than the file it replaces.
        answer: (obj) => this.pending.push(() => writeResult(resultPath, obj, { after: resultPath })),
      });
      // It worked on the prompt: its session records a turn, as a real agent's does when it responds.
      fs.appendFileSync(ag.session, `${JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 1, output: 1 } } })}\n`);
      return this.ok({ agent: { agent_status: 'working' } });
    }
    return this.err('unknown', a.join(' '));
  }
}

// A result's time is the relay's clock (Date.now(), which the fault sweep advances), as for a real worker
// writing while the relay waits.
// Successive writes of a file never go back in time.
export function writeResult(file, obj, { after } = {}) {
  const before = after && fs.existsSync(after) ? fs.statSync(after).mtimeMs : null;
  const previous = fs.existsSync(file) ? fs.statSync(file).mtimeMs : null;
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  const t = new Date(Math.max(Date.now(), before !== null ? before + 1000 : 0, previous !== null ? previous + 1 : 0));
  fs.utimesSync(file, t, t);
}

export const done = (summary = 'done', extra = {}) => ({ status: 'done', summary, checks: ['fake → pass'], ...extra });
// done() for an implementer in any slice: in FINAL it also reports the full verification passed.
export const finished = (c, summary = 'done') => done(summary, c.slice === 'FINAL' ? { verification: 'pass' } : {});
export const accept = () => done('accepted', { verdict: 'accept', blocking: [] });
export const changes = (...blocking) => done('changes required', { verdict: 'changes-required', blocking });
export const brief = (extra = {}) => ({
  status: 'needs-decision', summary: 'brief',
  brief: { title: 'T', question: 'Q?', context: 'C', options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r', notes: [], ...extra },
});
export const decision = (extra = {}) => ({
  status: 'done', summary: 'owner chose', title: 'Test decision', decision: 'The owner chose A.', chosen: 1,
  replies: { implementer: 'Proceed with A.', reviewer: 'Check A.' }, ...extra,
});

// The usual worker behaviour: implementers commit <slice>.txt and finish, reviewers accept, the final
// step finds nothing to do and reports its verification passed. Tests override what they care about and fall back to this.
export function standard(c) {
  if (c.role === 'reviewer') return c.write(accept());
  if (c.role === 'implementer' || c.role === 'senior') {
    if (c.slice !== 'FINAL') c.p.commit(`${c.slice.toLowerCase()}-${c.role}-${c.n}.txt`);
    return c.write(finished(c, `${c.slice} done`));
  }
  if (c.role === 'scout' || c.role === 'architect') return c.write(done(`${c.role} answered`));
  throw new Error(`no standard behaviour for ${c.role} in ${c.slice}`);
}
