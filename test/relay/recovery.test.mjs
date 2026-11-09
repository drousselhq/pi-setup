// Interruptions and failures the relay must survive: a Ctrl-C while a worker starts, a kill between two
// saves, a full disk, and a worker that asks for a decision after the owner answered it in its tab.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, TOPIC, accept, brief, decision, done, makeProject, standard, writeResult } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const flat = (h) => h.output.replace(/[┃\s]+/g, ' ');
const ask = (c, write = c.write) => write({
  status: 'needs-decision', summary: 'a choice', question: 'A or B?',
  options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r',
});
const compactTwice = (c) => fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n');

// The owner presses Ctrl-C just after Herdr started `role`'s agent. What is on disk at that moment is what
// the next run finds (the stop handler's own save does not count: a killed relay has none); `check` gets it.
function interruptStart(h, p, role, check = () => {}) {
  const handle = h.handle.bind(h);
  const seen = { disk: null, failure: null };
  h.handle = (a) => {
    const r = handle(a);
    if (a[0] !== 'agent' || a[1] !== 'start' || !a[2].includes(`-${role}-`)) return r;
    h.handle = handle;
    try {
      const disk = seen.disk = p.state();
      assert.equal(disk.cur.agents[role].starting, true, 'recorded as starting before the agent started');
      assert.equal(disk.cur.agents[role].name, a[2]);
      assert.match(disk.cur.agents[role].tab, /^t\d+$/);
      assert.equal(disk.seq, Number(a[2].split('-').at(-1)), 'the sequence number is saved, so the name is never reused');
      check(disk);
    } catch (e) { seen.failure = e; }
    throw new StopRelay('Ctrl-C');
  };
  return () => { assert.ok(seen.disk, 'the start was interrupted'); if (seen.failure) throw seen.failure; };
}

// The relay process is killed at the first state save whose content satisfies `when` (just before it, or
// just after it): from then on every file change and every io call fails, as for a process that is gone.
// Returns a function that restores the real file system.
// `file` names another file replaced atomically (decisions.md, plan.md): the kill then hits its rename.
function killAtSave(h, when, mode, file = '/relay/state.json') {
  const real = Object.fromEntries(['writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'mkdirSync'].map((n) => [n, fs[n]]));
  let dead = false;
  const alive = () => { if (dead) throw new StopRelay('killed'); };
  for (const n of Object.keys(real)) fs[n] = (...args) => { alive(); return real[n](...args); };
  fs.renameSync = (from, to) => {
    alive();
    const hit = String(to).endsWith(file) && when(fs.readFileSync(from, 'utf8'));
    if (hit && mode === 'before') { dead = true; alive(); }
    real.renameSync(from, to);
    if (hit && mode === 'after') { dead = true; alive(); }
  };
  const base = h.io();
  h.ioExtra = { herdr: (a) => { alive(); return h.handle(a); }, sleep: (ms) => { alive(); return base.sleep(ms); }, write: (t) => { alive(); base.write(t); } };
  return () => { Object.assign(fs, real); h.ioExtra = {}; };
}

// ---------- interrupted worker starts ----------

test('a Ctrl-C after Herdr started a worker but before the relay recorded it: the next run closes it and starts anew', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) { p.commit('a.txt'); return ask(c); }
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision()); }
    return standard(c);
  });
  const verify = interruptStart(h, p, 'reviewer', (disk) => {
    assert.match(disk.cur.notes.reviewer, /Check A\./, 'the advisor\'s note to the reviewer is still saved');
  });
  assert.equal(h.run(), 1);
  verify();
  const orphan = h.starts.find((s) => s.role === 'reviewer').name;
  assert.equal(h.run(), 0, 'no agent_name_taken crash');
  assert.equal(h.agents.get(orphan).alive, false, 'the leftover worker\'s tab is closed');
  const reviewers = h.starts.filter((s) => s.role === 'reviewer');
  assert.equal(reviewers.length, 2);
  assert.notEqual(reviewers[1].name, orphan);
  assert.ok(p.events().some((e) => e.type === 'agent_start_recovered' && e.agent === orphan));
  const review = h.prompts.find((c) => c.role === 'reviewer');
  assert.match(review.assignment() + review.text, /Owner decision D1 .*Check A\./s, 'the note reaches the reviewer');
});

test('an interrupted restart of a worker that resumes its session resumes the same session next time', () => {
  const p = makeProject({ plan: ONE });
  let session = null;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) {
      session = c.session;
      c.write({ status: 'blocked', summary: 'stuck', question: 'Q?' });
      // Its tab dies, then the owner stops the relay.
      return c.later(() => { h.agents.get(c.name).alive = false; throw new StopRelay('Ctrl-C'); });
    }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  const verify = interruptStart(h, p, 'reviewer', (disk) => assert.equal(disk.cur.agents.reviewer.session, session));
  assert.equal(h.run(), 1);
  verify();
  const { resultPath } = p.state().cur.pending;
  h.pending.push(() => writeResult(resultPath, accept(), { after: resultPath })); // the owner answers the block
  assert.equal(h.run(), 0);
  const reviewers = h.starts.filter((s) => s.role === 'reviewer');
  assert.equal(reviewers.length, 3);
  assert.deepEqual([reviewers[2].resumed, reviewers[2].session], [true, session]);
});

test('a worker Herdr fails to start is started on the next run without a false recovery', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  const handle = h.handle.bind(h);
  h.handle = (a) => {
    if (a[0] !== 'agent' || a[1] !== 'start' || !a[2].includes('-reviewer-')) return handle(a);
    h.handle = handle;
    return h.err('agent_not_ready', 'not ready');
  };
  assert.equal(h.run(), 1);
  assert.equal(h.run(), 0);
  assert.ok(!p.events().some((e) => e.type === 'agent_start_recovered'));
});

// ---------- a kill at the save that records a successor ----------
// (faults-*.test.mjs kill every save of whole scenarios; these name the incident's two cases.)

for (const mode of ['before', 'after']) {
  test(`a kill just ${mode} the save that hands an implementer stopped at the compaction limit to the senior: the senior takes over`, () => {
    const p = makeProject({ plan: ONE });
    const h = new FakeHerdr(p, (c) => (c.role === 'implementer' && c.slice === 'S1' && c.n === 1 ? compactTwice(c) : standard(c)));
    const restore = killAtSave(h, (text) => JSON.parse(text).cur?.queued?.role === 'senior', mode);
    try { assert.throws(() => h.run(), StopRelay); } finally { restore(); }
    assert.equal(p.state().cur.queued?.role ?? p.state().cur.pending.role, mode === 'after' ? 'senior' : 'implementer');
    assert.equal(h.run(), 0);
    assert.equal(h.starts.filter((s) => s.role === 'implementer').length, 2, 'S1\'s implementer is not restarted (the other is FINAL\'s)');
    assert.ok(h.prompts.some((c) => c.role === 'senior' && c.slice === 'S1'));
    assert.ok([...h.agents.values()].every((a) => !a.alive), 'no tab left open');
  });

  test(`a kill just ${mode} the save that queues a stopped reviewer's retry: the retry runs in a new session`, () => {
    const p = makeProject({ plan: ONE, config: { escalation: { enabled: false } } });
    const h = new FakeHerdr(p, (c) => (c.role === 'reviewer' && c.n === 1 ? compactTwice(c) : standard(c)));
    const restore = killAtSave(h, (text) => JSON.parse(text).cur?.queued?.retryOf === 'runaway', mode);
    try { assert.throws(() => h.run(), StopRelay); } finally { restore(); }
    const codes = [h.run()];
    if (codes[0] === 2) codes.push(h.run()); // killed before the save: the restart stops at the limit again
    assert.equal(codes.at(-1), 0);
    const reviewers = h.starts.filter((s) => s.role === 'reviewer');
    assert.equal(reviewers.length, 2);
    assert.equal(reviewers[1].resumed, false, 'the closed session is not reused');
    assert.ok([...h.agents.values()].every((a) => !a.alive), 'no tab left open');
  });
}

// ---------- atomic records, delivery, prerequisites outside a plan slice, startup ----------

const TWO = '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- one\n\n## S2: Second\nNeeds: none\nAcceptance:\n- two\n';
const prerequisite = (title = 'Make the fixture') => decision({ slice: { title, acceptance: ['the fixture exists'] } });

test('a kill inside the atomic rewrite of decisions.md leaves the earlier decisions whole and records the new one once', () => {
  const p = makeProject({ plan: TWO });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && (c.slice === 'S1' || c.slice === 'S2') && c.n === 1) { p.commit(`${c.slice}-early.txt`); return ask(c); }
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision({ title: `Choice for ${c.slice}` })); }
    return standard(c);
  });
  const restore = killAtSave(h, (text) => /## D2 /.test(text), 'before', '/decisions.md');
  try { assert.throws(() => h.run(), StopRelay); } finally { restore(); }
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · Choice for S1\n\nThe owner chose A\./, 'D1 intact');
  assert.doesNotMatch(p.read('decisions.md'), /## D2/);
  assert.equal(h.run(), 0);
  assert.deepEqual(p.read('decisions.md').match(/^## D\d+ /gm), ['## D1 ', '## D2 ']);
});

test('a kill inside the atomic rewrite of plan.md inserts the prerequisite slice once', () => {
  const p = makeProject({ plan: TWO });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) return ask(c);
    if (c.role === 'advisor') { c.write(brief()); return c.answer(prerequisite()); }
    return standard(c);
  });
  const restore = killAtSave(h, (text) => /## S1b:/.test(text), 'before', '/plan.md');
  try { assert.throws(() => h.run(), StopRelay); } finally { restore(); }
  assert.doesNotMatch(p.read('plan.md'), /S1b/, 'the plan is the previous version');
  assert.equal(h.run(), 0);
  assert.equal(p.read('plan.md').match(/^## S1b:/gm).length, 1);
  assert.deepEqual(Object.keys(p.state().slices).sort(), ['FINAL', 'S1', 'S1B', 'S2']);
});

test('a step that reached its worker just before a kill is not sent again: the worker had started on it', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  const restore = killAtSave(h, (text) => JSON.parse(text).cur?.pending?.role === 'reviewer' && JSON.parse(text).cur.pending.delivered === true, 'before');
  try { assert.throws(() => h.run(), StopRelay); } finally { restore(); }
  assert.equal(h.run(), 0);
  assert.equal(h.prompts.filter((c) => c.role === 'reviewer').length, 1, 'one review prompt');
});

test('a step whose prompt never left the relay is delivered after the restart', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  const restore = killAtSave(h, (text) => JSON.parse(text).cur?.pending?.role === 'reviewer' && JSON.parse(text).cur.pending.delivered === false, 'after');
  try { assert.throws(() => h.run(), StopRelay); } finally { restore(); }
  assert.equal(h.prompts.filter((c) => c.role === 'reviewer').length, 0);
  assert.equal(h.run(), 0);
  assert.equal(h.prompts.filter((c) => c.role === 'reviewer').length, 1);
});

test('a brief the owner already answered is not shown again after a kill: his answer is used', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return ask(c);
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision()); }
    return standard(c);
  });
  const restore = killAtSave(h, (text) => Boolean(JSON.parse(text).cur?.advice?.recording), 'before');
  try { assert.throws(() => h.run(), StopRelay); } finally { restore(); }
  const shown = () => p.events().filter((e) => e.type === 'operator_wait_start' && e.role === 'advisor').length;
  assert.equal(shown(), 1);
  assert.equal(h.run(), 0);
  assert.equal(shown(), 1, 'the answered brief was not shown to the owner again');
  assert.equal(p.read('decisions.md').match(/^## D\d+ /gm).length, 1);
});

test('a prerequisite slice chosen during planning stops with advice instead of looping', () => {
  const p = makeProject({ plan: null });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'planner') return ask(c);
    if (c.role === 'advisor') { assert.match(c.assignment(), /A prerequisite slice cannot be added now: no plan exists yet/); c.write(brief()); return c.answer(prerequisite()); }
    return standard(c);
  });
  assert.equal(h.run(), 2);
  assert.match(flat(h), /asks for a prerequisite slice \("Make the fixture"\), but no plan exists yet to insert it into\. Answer the planner in its tab before re-running/);
  assert.equal(p.state().cur.advice, null);
  assert.ok(!fs.existsSync(p.file('plan.md')));
});

test('a prerequisite slice chosen during a final verification that changed files stops with advice', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL') { p.commit('final-fix.txt'); return ask(c); }
    if (c.role === 'advisor') { c.write(brief()); return c.answer(prerequisite()); }
    return standard(c);
  });
  assert.equal(h.run(), 2);
  assert.match(flat(h), /but FINAL already has commits or changes since it started, so it cannot be set aside/);
  assert.doesNotMatch(p.read('plan.md'), /## S1b/);
});

test('a prerequisite slice chosen during a final verification that changed nothing runs, then the final verification starts again', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL' && c.n === 1) return ask(c);
    if (c.role === 'advisor') { assert.match(c.assignment(), /a prerequisite slice can be added after the plan's last slice/); c.write(brief()); return c.answer(prerequisite('Add the fixture')); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(p.read('plan.md'), /## S1b: Add the fixture\nNeeds: none\nAcceptance:\n- the fixture exists\nNotes: Prerequisite for the final verification, inserted by pi-relay from owner decision D1\./);
  assert.deepEqual(h.prompts.map((c) => `${c.slice}:${c.role}`).slice(-4), ['FINAL:advisor', 'S1B:implementer', 'S1B:reviewer', 'FINAL:implementer']);
  assert.ok(p.events().some((e) => e.type === 'slice_set_aside' && e.slice === 'FINAL' && e.restart));
});

test('tabs a killed relay released are closed by the next relay, but not by one the lock refuses', () => {
  const p = makeProject({ plan: ONE });
  let reviewing = false; // the reviewer works on its step until the owner stops the relay
  const h = new FakeHerdr(p, (c) => {
    if (c.role !== 'reviewer' || reviewing) return standard(c);
    if (c.n === 1) c.later(() => { throw new StopRelay('Ctrl-C'); });
    return undefined;
  });
  assert.equal(h.run(), 1);
  reviewing = true;
  const st = p.state();
  const reviewer = st.cur.agents.reviewer;
  st.closingTabs = [{ tab: reviewer.tab, name: reviewer.name, wait: true }]; // as a kill after the release's save leaves it
  delete st.cur.agents.reviewer;
  fs.writeFileSync(p.file('relay/state.json'), JSON.stringify(st));
  fs.writeFileSync(p.file('relay/lock'), '424242');
  h.ioExtra.processAlive = (pid) => pid === 424242;
  assert.equal(h.run(), 2, 'refused: another relay holds the lock');
  assert.equal(h.agents.get(reviewer.name).alive, true, 'the refused relay closed nothing');
  h.ioExtra = {};
  fs.rmSync(p.file('relay/lock'));
  assert.equal(h.run(), 0);
  assert.equal(h.agents.get(reviewer.name).alive, false);
});

// ---------- a full disk ----------

test('a full disk stops the relay with that cause, even when the stop itself cannot be recorded', () => {
  const p = makeProject({ plan: ONE });
  const real = { writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync };
  let full = false;
  const enospc = (fn) => (...args) => {
    if (full) throw Object.assign(new Error(`ENOSPC: no space left on device, write '${args[0]}'`), { code: 'ENOSPC' });
    return fn(...args);
  };
  fs.writeFileSync = enospc(real.writeFileSync);
  fs.appendFileSync = enospc(real.appendFileSync);
  try {
    const h = new FakeHerdr(p, (c) => {
      const r = standard(c);
      if (c.role === 'implementer') full = true; // the disk fills up while the implementer works
      return r;
    });
    assert.equal(h.run(), 1);
    const stop = flat(h);
    assert.match(stop, /Unexpected error: the disk is full \(ENOSPC: no space left on device/);
    assert.match(stop, /Free some space, then start pi-relay tt again\./);
    assert.match(stop, /This stop could not be recorded in state\.json \(ENOSPC.*\) or log\.md \(ENOSPC/);
  } finally {
    Object.assign(fs, real);
  }
});

// ---------- a decision asked after the owner answered in the worker's tab ----------

test('a decision asked after the owner answered a block goes to the advisor, not to the worker\'s tab', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) {
      c.write({ status: 'blocked', summary: 'stuck', question: 'May I read the b files?' });
      return ask(c, c.answer); // after the owner's answer in its tab, it asks for a decision
    }
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision()); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.ok(h.prompts.some((c) => c.role === 'advisor'), 'the advisor prepared the brief');
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · Test decision/);
  const reply = h.prompts.filter((c) => c.role === 'reviewer')[1];
  assert.match(reply.text, /Owner decision D1 .*\n\nCheck A\./);
  assert.match(p.log(), /S1 reviewer asked for a decision after operator input/);
});

for (const advisor of [true, false]) {
  test(`a decision asked after a worker stopped twice without a result goes to the ${advisor ? 'advisor' : 'owner in its tab (advisor off)'}`, () => {
    const p = makeProject({ plan: ONE, config: { advisor: { enabled: advisor } } });
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return undefined; // no result
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) { // ignores the reminder; then, talked to, asks
        return c.later(() => {
          ask(c);
          if (!advisor) h.pending.push(() => { p.commit('owner.txt'); writeResult(c.resultPath, done(), { after: c.resultPath }); });
        });
      }
      if (c.role === 'advisor') { c.write(brief()); return c.answer(decision()); }
      return standard(c);
    });
    assert.equal(h.run(), 0);
    assert.equal(h.prompts.some((c) => c.role === 'advisor'), advisor);
    if (advisor) assert.match(h.prompts.filter((c) => c.role === 'implementer')[2].text, /Owner decision D1 .*\n\nProceed with A\./);
  });
}
