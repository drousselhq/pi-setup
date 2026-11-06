// Interruptions and failures the relay must survive: a Ctrl-C while a worker starts, a kill between two
// saves, a full disk, and a worker that asks for a decision after the owner answered it in its tab.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, accept, brief, decision, done, makeProject, standard, writeResult } from './harness.mjs';

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

// The relay process is killed at a save: from the first state save after `when(herdrArgs)` plus `allowed`
// more, no save reaches the disk in this run. Returns a function that restores the real file system.
function killAtSave(h, when, allowed) {
  const real = fs.renameSync;
  const handle = h.handle.bind(h);
  let armed = false;
  let dead = false;
  h.handle = (a) => { const r = handle(a); if (when(a)) armed = true; return r; };
  fs.renameSync = (from, to) => {
    if (dead || (armed && String(to).endsWith('state.json') && allowed-- <= 0)) { dead = true; throw new StopRelay('killed'); }
    return real(from, to);
  };
  return () => { fs.renameSync = real; h.handle = handle; };
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

// ---------- a kill between closing a worker and recording its successor ----------

test('a kill while an implementer stopped at the compaction limit is handed over still leaves the senior queued', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => (c.role === 'implementer' && c.slice === 'S1' && c.n === 1 ? compactTwice(c) : standard(c)));
  const tab = () => p.state().cur.agents.implementer?.tab;
  const restore = killAtSave(h, (a) => a[0] === 'tab' && a[1] === 'close' && a[2] === tab(), 1);
  try { assert.equal(h.run(), 1); } finally { restore(); }
  assert.equal(p.state().cur.queued.role, 'senior');
  assert.equal(h.run(), 0);
  assert.equal(h.starts.filter((s) => s.role === 'implementer').length, 2, 'S1\'s closed implementer is not restarted (the other is FINAL\'s)');
  assert.ok(h.prompts.some((c) => c.role === 'senior' && c.slice === 'S1'));
});

test('a kill while a reviewer stopped at the compaction limit is closed still leaves its retry queued', () => {
  const p = makeProject({ plan: ONE, config: { escalation: { enabled: false } } });
  const h = new FakeHerdr(p, (c) => (c.role === 'reviewer' && c.n === 1 ? compactTwice(c) : standard(c)));
  const tab = () => p.state().cur.agents.reviewer?.tab;
  const restore = killAtSave(h, (a) => a[0] === 'tab' && a[1] === 'close' && a[2] === tab(), 1);
  try { assert.equal(h.run(), 1); } finally { restore(); }
  assert.equal(p.state().cur.queued.retryOf, 'runaway');
  assert.equal(h.run(), 0);
  const reviewers = h.starts.filter((s) => s.role === 'reviewer');
  assert.equal(reviewers.length, 2);
  assert.equal(reviewers[1].resumed, false, 'the closed session is not reused');
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
