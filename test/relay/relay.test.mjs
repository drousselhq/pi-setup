import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  FakeHerdr, StopRelay, TOPIC, accept, brief, changes, decision, done, makeProject, standard, writeResult,
} from './harness.mjs';

const roles = (h) => h.prompts.map((c) => `${c.slice}:${c.role}`);

test('a plan runs slice by slice: implement, review, then the final verification', () => {
  const p = makeProject();
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h), ['S1:implementer', 'S1:reviewer', 'S2:implementer', 'S2:reviewer', 'FINAL:implementer']);
  const s = p.state();
  assert.deepEqual(Object.keys(s.slices), ['S1', 'S2', 'FINAL']);
  assert.equal(s.cur, null);
  assert.equal(s.slices.S2.base, s.slices.S1.head);
  assert.match(p.log(), /relay complete/);
  assert.match(h.prompts[1].assignment(), /commits [0-9a-f]{40}\.\.HEAD/);
  assert.ok([...h.agents.values()].every((a) => !a.alive), 'every tab is closed at the end');
});

test('without a plan, the planner writes one first', () => {
  const p = makeProject({ plan: null });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'planner') { fs.writeFileSync(p.file('plan.md'), '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n'); return c.write(done('planned')); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h), ['PLAN:planner', 'S1:implementer', 'S1:reviewer', 'FINAL:implementer']);
});

test('a rejected review goes back to the implementer with the blocking findings', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) return c.write(changes('R1'));
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h), ['S1:implementer', 'S1:reviewer', 'S1:implementer', 'S1:reviewer', 'FINAL:implementer']);
  assert.match(h.prompts[2].text, /Review loop 1: fix the blocking findings R1/);
  assert.match(h.prompts[3].text, /Re-review those repairs/);
  assert.equal(p.state().slices.S1.cycles, 1);
});

test('after two rejected reviews the senior implementer takes over in a fresh session', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n <= 2) return c.write(changes(`R${c.n}`));
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h), ['S1:implementer', 'S1:reviewer', 'S1:implementer', 'S1:reviewer', 'S1:senior', 'S1:reviewer', 'FINAL:implementer']);
  assert.match(h.prompts[4].assignment(), /You are the senior implementer taking over this slice: 2 review loops without acceptance/);
  assert.match(p.state().slices.S1.escalated, /2 review loops/);
});

test('a finding that comes back after a repair escalates at once', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n', config: { escalation: { enabled: true, afterLoops: 5, onRecurringFinding: true, maxLoops: 2 } } });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n <= 2) return c.write(changes('R1'));
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(h.prompts[4].role, 'senior');
  assert.match(p.state().slices.S1.escalated, /R1 came back after a repair/);
});

test('a worker that stops without a result is reminded once', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return undefined; // writes nothing
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(h.prompts[1].text, /You stopped without writing the result file/);
  assert.ok(p.events().some((e) => e.type === 'nudge' && e.reason === 'missing-result'));
});

test('an unparseable result is reported to the worker, which rewrites it', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) { p.commit('a.txt'); return c.write('{"status": "done",'); }
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) return c.write(done());
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(h.prompts[1].text, /Your result file is invalid \(Unparseable result JSON/);
});

test('a scout question is answered by a scout, then the implementer continues', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return c.write({ status: 'needs-scout', summary: 'lost', question: 'Where is X?' });
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).slice(0, 4), ['S1:implementer', 'S1:scout', 'S1:implementer', 'S1:reviewer']);
  assert.match(h.prompts[1].assignment(), /Answer this question from the implementer, in your artifact: Where is X\?/);
  assert.match(h.prompts[2].text, /The scout answered your question/);
});

test('a slice that needs architecture gets the architect before the implementer', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: architecture\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).slice(0, 3), ['S1:architect', 'S1:implementer', 'S1:reviewer']);
});

// ---------- the owner and the advisor ----------

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const askOnce = (extra = {}) => (c) => c.write({
  status: 'needs-decision', summary: 'a choice', question: 'A or B?',
  options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r', ...extra,
});

test('a decision goes through the advisor, is recorded, and the reply reaches the worker', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce()(c);
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision()); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · Test decision\n\nThe owner chose A\./);
  assert.match(h.prompts[2].text, /Owner decision D1 .*\n\nProceed with A\./);
  assert.match(h.prompts[3].assignment() + h.prompts[3].text, /Owner decision D1 .*Check A\./s, 'the reviewer gets its note');
});

test('an unparseable decision is rewritten by the advisor without asking the owner again', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce()(c);
    if (c.role === 'advisor' && c.n === 1) { c.write(brief()); return c.answer('{"status": "done", "decision": "x",'); }
    if (c.role === 'advisor' && c.n === 2) { assert.match(c.text, /is invalid .*Do not ask the owner again/s); return c.write(decision()); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(p.read('decisions.md'), /## D1/);
  assert.ok(!/advisor unavailable/.test(p.log()));
});

test('an incomplete brief gets one reminder, then the owner is asked directly', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce()(c);
    if (c.role === 'advisor') return c.write({ status: 'needs-decision', summary: 'x', brief: { title: 'no question' } });
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) throw new Error('unexpected');
    return standard(c);
  });
  // The fallback waits for the owner in the worker's tab: the owner answers by the worker rewriting its result.
  const orig = h.worker;
  h.worker = (c) => {
    orig(c);
    if (c.role === 'advisor' && c.n === 2) {
      const worker = h.prompts.find((x) => x.role === 'implementer');
      c.later(() => writeResult(worker.resultPath, done('answered in the tab'), { after: worker.resultPath }));
    }
  };
  assert.equal(h.run(), 0);
  assert.match(h.prompts[2].text, /Your brief is incomplete/);
  assert.match(p.log(), /advisor unavailable \(incomplete brief\); asking the owner directly/);
});

// ---------- prerequisite slices ----------

const SLICE = { title: 'Make the fixture', acceptance: ['fixture.txt exists'], notes: 'Needed by S2.' };

test('a prerequisite slice chosen by the owner runs first, then the slice resumes with the same worker', () => {
  const p = makeProject();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) return askOnce({ options: [{ label: 'Fixture first', consequence: 'f', slice: SLICE }, { label: 'Stop', consequence: 's' }] })(c);
    if (c.role === 'advisor') {
      assert.match(c.assignment(), /a prerequisite slice can be inserted before it/);
      c.write(brief());
      return c.answer(decision({ slice: SLICE, replies: { implementer: 'Use the fixture.' } }));
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h), ['S1:implementer', 'S1:reviewer', 'S2:implementer', 'S2:advisor', 'S1B:implementer', 'S1B:reviewer', 'S2:implementer', 'S2:reviewer', 'FINAL:implementer']);
  assert.match(p.read('plan.md'), /## S1b: Make the fixture\nNeeds: none\nAcceptance:\n- fixture.txt exists\nNotes: Prerequisite for S2, inserted by pi-relay from owner decision D1\. Needed by S2\.\n\n## S2: Second/);
  const s = p.state();
  assert.equal(s.slices.S2.base, s.slices.S1B.head, 'S2 is reviewed from the prerequisite\'s head');
  const s2 = h.starts.filter((x) => x.name.includes('implementer') && h.prompts.find((c) => c.name === x.name)?.slice === 'S2');
  assert.equal(s2.length, 2);
  assert.equal(s2[1].session, s2[0].session, 'the same Pi session resumes');
  assert.equal(s2[1].resumed, true);
  const resume = h.prompts[6].text;
  assert.match(resume, /Owner decision D1 .*Use the fixture\./s);
  assert.match(resume, /The prerequisite slice S1B \("Make the fixture"\) is done; its commits:/);
  assert.match(h.prompts[7].assignment(), new RegExp(`commits ${s.slices.S1B.head}\\.\\.HEAD`));
});

test('a prerequisite slice is refused when the current slice already has commits', () => {
  const p = makeProject();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) { p.commit('early.txt'); return askOnce()(c); }
    if (c.role === 'advisor') {
      assert.match(c.assignment(), /cannot be inserted before it: do not offer that option/);
      c.write(brief());
      return c.answer(decision({ slice: SLICE }));
    }
    return standard(c);
  });
  const planBefore = p.read('plan.md');
  assert.equal(h.run(), 2);
  assert.equal(p.read('plan.md'), planBefore);
  assert.match(p.read('decisions.md'), /## D1/);
  assert.match(p.log(), /STOPPED: Owner decision D1 asks for a prerequisite slice \("Make the fixture"\) before S2, but S2 already has commits/);
  assert.equal(p.state().cur.slice, 'S2');
});

test('a slice added to the plan by hand ahead of an untouched slice runs first after a restart', () => {
  const p = makeProject();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) {
      c.write({ status: 'blocked', summary: 'no fixture', question: 'The fixture is missing' });
      return c.later(() => { throw new StopRelay('owner pressed Ctrl-C'); });
    }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  fs.writeFileSync(p.file('plan.md'), p.read('plan.md').replace('## S2:', '## S1b: Fixture\nNeeds: none\nAcceptance:\n- f\n\n## S2:'));
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).slice(2), ['S2:implementer', 'S1B:implementer', 'S1B:reviewer', 'S2:implementer', 'S2:reviewer', 'FINAL:implementer']);
  assert.match(h.prompts[5].text, /The owner added slice S1B to plan\.md before this slice/);
  assert.equal(p.state().slices.S2.base, p.state().slices.S1B.head);
});

test('a slice added by hand ahead of a slice with commits stops the relay', () => {
  const p = makeProject();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) {
      p.commit('early.txt');
      c.write({ status: 'blocked', summary: 'no fixture', question: 'The fixture is missing' });
      return c.later(() => { throw new StopRelay('owner pressed Ctrl-C'); });
    }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  fs.writeFileSync(p.file('plan.md'), p.read('plan.md').replace('## S2:', '## S1b: Fixture\nNeeds: none\nAcceptance:\n- f\n\n## S2:'));
  assert.equal(h.run(), 2);
  assert.match(p.log(), /STOPPED: plan\.md now puts S1B before the current slice S2, but S2 already has commits/);
  assert.equal(p.state().cur.slice, 'S2');
});

test('a stopped relay resumes the same step on restart', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    // The reviewer ignores its step and the reminder; the owner stops the relay while it waits.
    if (c.role === 'reviewer' && c.n === 1) return undefined;
    if (c.role === 'reviewer' && c.n === 2) return c.later(() => { throw new StopRelay('Ctrl-C'); });
    return standard(c);
  });
  assert.equal(h.run(), 1);
  assert.equal(p.state().cur.pending.role, 'reviewer');
  const before = h.prompts.length;
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).slice(before), ['S1:reviewer', 'FINAL:implementer'], 'the restart continues the review, nothing earlier');
});

test('two relays with the same topic in different projects get distinct agent names', () => {
  const names = [makeProject({ plan: ONE }), makeProject({ plan: ONE })].map((p) => {
    const h = new FakeHerdr(p, standard);
    assert.equal(h.run(), 0);
    return h.starts.map((x) => x.name);
  });
  assert.ok(names.flat().every((n) => /^[a-z][a-z0-9_-]{0,31}$/.test(n) && n.startsWith(`${TOPIC}-`)), names.flat().join(' '));
  assert.equal(names[0].filter((n) => names[1].includes(n)).length, 0);
});

// ---------- status, quota, compaction limit ----------

test('--status shows done, current and set-aside slices without starting anything', () => {
  const p = makeProject();
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  h.output = '';
  assert.equal(h.run([TOPIC, '--status']), 0);
  assert.match(h.output, /S1\s+✓ done\s+First/);
  assert.match(h.output, /FINAL\s+✓ done/);
  assert.match(h.output, /slices 2\/2/);
});

test('a nearly used 5-hour quota window pauses the next step until it resets', () => {
  const anthropic = Object.fromEntries(['implementer', 'reviewer', 'senior', 'advisor', 'planner', 'scout', 'architect']
    .map((r) => [r, { model: `anthropic/test-${r}`, thinking: 'low' }]));
  const p = makeProject({ plan: ONE, config: { roles: anthropic, quota: { enabled: true, fiveHourMaxPercent: 90, weeklyPaceMarginPercent: 10 } } });
  const h = new FakeHerdr(p, standard);
  let reads = 0;
  h.ioExtra.fetchUsage = () => {
    reads++;
    const resets = new Date(Date.now() + 60_000).toISOString();
    return { status: 200, body: { five_hour: { utilization: reads === 1 ? 95 : 5, resets_at: resets } } };
  };
  // Waiting takes no time in the harness; in reality the pause outlasts the shared reading's freshness.
  // Removing the shared cache file during the wait stands in for that.
  const base = h.io().sleep;
  h.ioExtra.sleep = (ms) => { fs.rmSync(`${p.relayHome}/usage-cache.json`, { force: true }); base(ms); };
  assert.equal(h.run(), 0);
  const types = p.events().map((e) => e.type);
  assert.ok(types.includes('quota_pause') && types.includes('quota_pause_end'), types.join(' '));
  assert.ok(fs.existsSync(`${p.relayHome}/usage-cache.json`), 'the shared reading lives in the relay home');
  assert.equal(reads, 2);
});

test('a worker that compacts too often without a result is handed to the senior', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) {
      fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n');
      return undefined;
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(h.prompts[1].role, 'senior');
  assert.match(h.prompts[1].assignment(), /the implementer was stopped after 2 compactions in one step/);
});
