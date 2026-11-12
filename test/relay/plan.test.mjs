// What the relay refuses before it acts on it: a reviewer result that contradicts itself, and a plan.md
// that would silently drop slices or their preparation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, TOPIC, accept, changes, done, makeProject, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const flat = (h) => h.output.replace(/[┃\s]+/g, ' ');
const roles = (h) => h.prompts.map((c) => `${c.slice}:${c.role}`);

// ---------- contradictory reviewer results ----------

test('an accepting review that lists blocking findings is invalid: the reminder names it, and the slice waits for a usable verdict', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) return c.write(done('looks fine', { verdict: 'accept', blocking: ['R1'] }));
    if (c.role === 'reviewer' && c.n === 2) {
      assert.match(c.text, /Your result file is invalid \(verdict "accept" lists blocking findings \(R1\): accept only with none, or set "changes-required"\)/);
      return c.write(changes('R1'));
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).slice(0, 5), ['S1:implementer', 'S1:reviewer', 'S1:reviewer', 'S1:implementer', 'S1:reviewer'],
    'the contradictory accept did not finish the slice: R1 was repaired and re-reviewed');
});

test('a review that requires changes without naming a blocking finding is invalid', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) return c.write(done('needs work', { verdict: 'changes-required', blocking: [] }));
    if (c.role === 'reviewer' && c.n === 2) {
      assert.match(c.text, /verdict "changes-required" lists no blocking finding: give their IDs in "blocking", or accept/);
      return c.write(accept());
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
});

test('a reviewer that repeats the contradiction after the reminder is shown to the owner with the reason', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n <= 2) return c.write(done('fine', { verdict: 'accept', blocking: ['R2'] }));
    if (c.role === 'reviewer' && c.n === 3) return undefined;
    return standard(c);
  });
  // The owner never answers: the harness reports a wait that cannot end.
  assert.equal(h.run(), 1);
  assert.match(flat(h), /The worker's result file is still invalid: verdict "accept" lists blocking findings \(R2\)/);
  assert.equal(p.state().slices.S1, undefined, 'the slice is not done');
});

// ---------- malformed plans ----------

const malformed = [
  ['a plan without slices', '# Plan\n\nWe will add a parser.\n', /plan\.md has no slices/],
  ['a heading meant as a slice', '# Plan\n\n## Step 1: Required work\nNeeds: none\nAcceptance:\n- x\n', /line 3 "## Step 1: Required work" looks like a slice heading/],
  ['a slice heading without its colon', '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- x\n\n## S2 Second part\nAcceptance:\n- y\n', /line 8 "## S2 Second part" looks like a slice heading/],
  ['a misspelled preparation', '# Plan\n\n## S1: First\nNeeds: acceptence\nAcceptance:\n- x\n', /line 4 \(slice S1\): Needs "acceptence" is not none, scout, architecture, acceptance or an earlier slice/],
  ['a later slice as a need', '# Plan\n\n## S1: First\nNeeds: S2\nAcceptance:\n- x\n\n## S2: Second\nNeeds: none\nAcceptance:\n- y\n', /line 4 \(slice S1\): Needs "S2"/],
  ['an empty Needs:', '# Plan\n\n## S1: First\nNeeds:\nAcceptance:\n- x\n', /line 4 \(slice S1\): Needs has no value \(write "none"\)/],
  ['a Needs: of punctuation only', '# Plan\n\n## S1: First\nNeeds: ???\nAcceptance:\n- x\n', /line 4 \(slice S1\): Needs has no value/],
  ['a slice that does not exist', '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- x\n\n## S2: Second\nNeeds: S1, S7\nAcceptance:\n- y\n', /line 9 \(slice S2\): Needs "S7"/],
];

for (const [name, plan, message] of malformed) {
  test(`${name} stops the relay before any work, naming the line`, () => {
    const p = makeProject({ plan });
    const h = new FakeHerdr(p, standard);
    assert.equal(h.run(), 2);
    assert.deepEqual(h.prompts, [], 'no worker was started');
    assert.match(flat(h), message);
    assert.match(p.log(), /STOPPED: plan\.md cannot be used as written/);
    assert.ok(!p.events().some((e) => e.type === 'run_complete'));
  });
}

test('slice dependencies, "nothing", ranges, punctuation and other headings stay valid', () => {
  const plan = `# Plan: dependencies

## Scope
Text about the work.

## S1: First
Needs: nothing.
Acceptance:
- a

## S2: Second
Needs: S1.
Acceptance:
- b

## S2a: Inserted
Needs: scout, S1
Acceptance:
- c

## S3: Third
Needs: S1\u2013S2a, architecture
Acceptance:
- d

## Not planned
- e
`;
  const p = makeProject({ plan });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  assert.deepEqual(Object.keys(p.state().slices), ['S1', 'S2', 'S2A', 'S3', 'FINAL']);
  assert.ok(roles(h).includes('S2A:scout') && roles(h).includes('S3:architect'), 'preparation still read from Needs:');
});

test('acceptance bullets count under a heading with a note in brackets or in bold, and an inline criterion in any script', () => {
  const plan = '# Plan\n\n## S1: First\nNeeds: none\nAcceptance (narrowed by council decision D4: two items):\n- a\n- b\n\n'
    + '## S2: Second\nNeeds: none\n**Acceptance:**\n- c\n\n## S3: Third\nNeeds: none\nAcceptance: 表示が正しい\n- d\n';
  const p = makeProject({ plan });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run([TOPIC, '--status']), 0);
  assert.match(h.output, /acceptance 0\/5/);
  assert.match(h.output, /S1\s+\S+ todo\s+First\s+acceptance 0\/2/);
  assert.match(h.output, /S3\s+\S+ todo\s+Third\s+acceptance 0\/2/, 'an inline criterion in any script counts');
});

test('--status still shows a malformed plan', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: First\nNeeds: acceptence\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run([TOPIC, '--status']), 0);
  assert.match(h.output, /S1\s+· todo\s+First/);
});

test('a plan edited into a malformed one during a run stops before the next slice, keeping the finished ones', () => {
  const TWO = '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- x\n\n## S2: Second\nNeeds: none\nAcceptance:\n- y\n';
  const p = makeProject({ plan: TWO });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.slice === 'S1') fs.writeFileSync(p.file('plan.md'), TWO.replace('## S2: Second', '## Step 2: Second'));
    return standard(c);
  });
  assert.equal(h.run(), 2, 'S2 is not silently skipped');
  assert.deepEqual(Object.keys(p.state().slices), ['S1']);
  assert.match(flat(h), /line 8 "## Step 2: Second" looks like a slice heading/);
  fs.writeFileSync(p.file('plan.md'), TWO);
  assert.equal(h.run(), 0);
  assert.deepEqual(Object.keys(p.state().slices), ['S1', 'S2', 'FINAL']);
});

test('the planner\'s instructions say that Needs: may name earlier slices and nothing else may follow it', () => {
  const p = makeProject({ plan: null });
  const h = new FakeHerdr(p, (c) => {
    if (c.role !== 'planner') return standard(c);
    assert.match(c.assignment(), /it may also name earlier slices \(`S1`, `S2a`, `S2\u2013S4`\) to document their order/);
    fs.writeFileSync(p.file('plan.md'), '# Plan\n\n## Step 1: Work\nAcceptance:\n- x\n');
    return c.write(done('planned'));
  });
  assert.equal(h.run(), 2);
  assert.match(flat(h), /The plan the planner wrote cannot be used as written: .*line 3 "## Step 1: Work" looks like a slice heading/);
  assert.equal(p.state().cur.pending.role, 'planner', 'the planner result stays pending for a corrected plan');
});

test('preparation written with punctuation or emphasis still runs', () => {
  const plan = '# Plan\n\n## S1: First\nNeeds: scout.\nAcceptance:\n- a\n\n## S2: Second\nNeeds: **architecture**;\nAcceptance:\n- b\n'
    + '\n## S3: Third\nNeeds: S1, acceptance.\nAcceptance:\n- c\n';
  const p = makeProject({ plan });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') throw new StopRelay('reached the acceptance worker');
    return standard(c);
  });
  assert.equal(h.run(), 1);
  const r = roles(h);
  assert.ok(r.includes('S1:scout'), r.join(' '));
  assert.ok(r.includes('S2:architect'), r.join(' '));
  assert.equal(r.at(-1), 'S3:acceptance', 'the acceptance tests are not skipped');
});

test('a restart while the planner is still writing its plan resumes the planner instead of stopping', () => {
  const p = makeProject({ plan: null });
  let restarted = false;
  const h = new FakeHerdr(p, (c) => {
    if (c.role !== 'planner') return standard(c);
    if (!restarted) { // still writing: a draft without slices, no result; the owner stops the relay meanwhile
      fs.writeFileSync(p.file('plan.md'), '# Plan\n\n## Scope\nStill writing.\n');
      if (c.n === 1) c.later(() => { throw new StopRelay('Ctrl-C'); });
      return undefined;
    }
    fs.writeFileSync(p.file('plan.md'), ONE);
    return c.write(done('planned'));
  });
  assert.equal(h.run(), 1);
  restarted = true;
  assert.equal(h.run(), 0, 'the draft is not checked while the planner is still working');
  assert.deepEqual(Object.keys(p.state().slices), ['PLAN', 'S1', 'FINAL']);
});

test('the plan format given to the planner shows a slice naming an earlier one', () => {
  const p = makeProject({ plan: null });
  const h = new FakeHerdr(p, (c) => {
    if (c.role !== 'planner') return standard(c);
    assert.match(c.assignment(), /## S2: <slice title>\nNeeds: S1\n/);
    fs.writeFileSync(p.file('plan.md'), ONE);
    return c.write(done('planned'));
  });
  assert.equal(h.run(), 0);
});
