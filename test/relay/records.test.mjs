// What the relay's records keep for later evaluation (the whole brief, the option chosen, the slice a decision
// belongs to), and what workers are told about asking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, brief, decision, makeProject, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const TWO = '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- one\n\n## S2: Second\nNeeds: none\nAcceptance:\n- two\n';
const ask = (c) => c.write({
  status: 'needs-decision', summary: 'a choice', question: 'A or B?',
  options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r',
});

test('workers are told to ask with needs-decision whatever the owner\'s word can settle, and to report blocked only otherwise', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  const assignment = h.prompts[0].assignment().replace(/\s+/g, ' ');
  assert.match(assignment, /Use `needs-decision`, with one precise question, for anything the owner's word can settle: a product or scope decision, a permission, a choice between approaches\. Use `blocked` only for what it cannot \(a broken tool, missing access, a full disk\), saying what must be fixed\./);
});

test('the brief, the option the owner chose and the decision\'s slice are kept in the events', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return ask(c);
    if (c.role === 'advisor') {
      c.write(brief({ options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b', deferral: { missing: 'm', source: 's', decisionPoint: 'd', interim: 'i' } }], notes: ['a note'] }));
      return c.answer(decision({ chosen: 2 }));
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const b = p.events().find((e) => e.type === 'advisor_brief');
  assert.deepEqual(b.options.map((o) => o.label), ['A', 'B']);
  assert.equal(b.options[1].deferral.interim, 'i', 'every field of every option');
  assert.deepEqual([b.title, b.question, b.context, b.recommended, b.reason, b.notes, b.ownerNeeded], ['T', 'Q?', 'C', 1, 'r', ['a note'], null]);
  const d = p.events().find((e) => e.type === 'owner_decision');
  assert.deepEqual([d.chosen, d.slice, d.prerequisite], [2, 'S1', null], 'the common slice field is the decision\'s slice');
});

test('a chosen number that is missing or outside the brief gets one reminder naming it; still missing, it is recorded as unknown', () => {
  for (const [first, second, recorded, why] of [
    [{ chosen: 7 }, { chosen: 1 }, 1, /is invalid \("chosen" must be an option number from 1 to 2, or null\)/],
    [{ chosen: undefined }, { chosen: 2 }, 2, /is invalid \("chosen" is missing: the option's number, or null\)/],
    [{ chosen: undefined }, { chosen: undefined }, null, /"chosen" is missing/],
  ]) {
    const p = makeProject({ plan: ONE });
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return ask(c);
      if (c.role === 'advisor' && c.n === 1) { c.write(brief()); return c.answer(decision(first)); }
      if (c.role === 'advisor') { assert.match(c.text, why); return c.write(decision(second)); }
      return standard(c);
    });
    assert.equal(h.run(), 0);
    assert.equal(p.events().find((e) => e.type === 'owner_decision').chosen, recorded);
    assert.equal(h.prompts.filter((c) => c.role === 'advisor').length, 2, 'one reminder');
  }
});

test('a decision that inserts a prerequisite slice names it in its own field, not in the event\'s slice', () => {
  const p = makeProject({ plan: TWO });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) return ask(c);
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision({ chosen: 1, slice: { title: 'Make the fixture', acceptance: ['it exists'] } })); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const d = p.events().find((e) => e.type === 'owner_decision');
  assert.deepEqual([d.slice, d.prerequisite, d.chosen], ['S2', 'Make the fixture', 1]);
});

test('the assignment states the compaction limit (none when it is off) and that decisions.md is the relay\'s', () => {
  for (const [limit, expected] of [[2, /The relay interrupts a step whose session compacts 2 times\. A step that large belongs in its own slice/], [0, null]]) {
    const p = makeProject({ plan: ONE, config: { maxCompactionsPerStep: limit } });
    const h = new FakeHerdr(p, standard);
    assert.equal(h.run(), 0);
    const a = h.prompts[0].assignment().replace(/\s+/g, ' ');
    if (expected) assert.match(a, expected);
    else assert.doesNotMatch(a, /compacts/);
    assert.match(a, /written by the relay, never edit it/);
  }
});

test('the advisor\'s assignment states no compaction limit: the relay never applies it to the advisor', () => {
  const p = makeProject({ plan: ONE, config: { maxCompactionsPerStep: 2 } });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return ask(c);
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision()); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const advisor = h.prompts.find((c) => c.role === 'advisor');
  assert.doesNotMatch(advisor.assignment(), /compacts/);
  assert.match(h.prompts.find((c) => c.role === 'implementer').assignment().replace(/\s+/g, ' '), /compacts 2 times/);
});

test('without maxCompactionsPerStep in the configuration, the compaction limit is 2', () => {
  const p = makeProject({ plan: ONE, config: { maxCompactionsPerStep: undefined } });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  assert.match(h.prompts[0].assignment().replace(/\s+/g, ' '), /compacts 2 times/);
});

test('the records name the installed setup and the plan\'s size; without a readable manifest or plan they say so', () => {
  const p = makeProject({ plan: TWO });
  fs.writeFileSync(path.join(p.root, '.pi-setup-install.json'), JSON.stringify({ commit: 'abc1234', installedAt: '2026-11-14T00:00:00Z', files: {} }));
  assert.equal(new FakeHerdr(p, standard).run(), 0);
  const events = p.events();
  const start = events.find((e) => e.type === 'run_start');
  assert.deepEqual(start.setup, { commit: 'abc1234', installedAt: '2026-11-14T00:00:00Z' });
  assert.deepEqual(start.plan, { slices: 2, acceptance: 2 });
  assert.deepEqual(events.find((e) => e.type === 'slice_start' && e.slice === 'S1').plan, { slices: 2, acceptance: 2 });
  const agents = events.filter((e) => e.type === 'agent_start');
  assert.ok(agents.length >= 2 && agents.every((e) => e.setup?.commit === 'abc1234'), 'every worker start names the prompts it got');

  const q = makeProject({ plan: null });
  fs.writeFileSync(path.join(q.root, '.pi-setup-install.json'), '{ not json');
  const planner = (c) => {
    if (c.role !== 'planner') return standard(c);
    fs.writeFileSync(q.file('plan.md'), ONE);
    return c.write({ status: 'done', summary: 'planned' });
  };
  assert.equal(new FakeHerdr(q, planner).run(), 0, 'an unreadable manifest never stops a run');
  const qStart = q.events().find((e) => e.type === 'run_start');
  assert.match(qStart.setup.error, /^unreadable install manifest/);
  assert.equal(qStart.plan, null, 'no plan yet: the planner writes it');

  const r = makeProject({ plan: ONE });
  assert.equal(new FakeHerdr(r, standard).run(), 0);
  assert.equal(r.events().find((e) => e.type === 'run_start').setup, null, 'no manifest: a run from a checkout');

  const d = makeProject({ plan: `${ONE}\n## S1: Again\nNeeds: none\nAcceptance:\n- y\n` });
  const dh = new FakeHerdr(d, standard);
  assert.equal(dh.run(), 2, 'a plan naming a slice twice stops the run as before');
  assert.equal(d.events().find((e) => e.type === 'run_start').plan, null, 'and its size is not recorded, without a different stop');
  assert.match(d.events().find((e) => e.type === 'run_stop').reason, /defines slice S1 twice/);
});

test('a worker session resumed after an install keeps the version of its first start', () => {
  const p = makeProject({ plan: ONE });
  const manifest = (commit) => fs.writeFileSync(path.join(p.root, '.pi-setup-install.json'), JSON.stringify({ commit, installedAt: 't', files: {} }));
  manifest('A');
  let stop = true;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && stop) { stop = false; throw new StopRelay('Ctrl-C during the review'); }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  for (const a of h.agents.values()) if (a.role === 'reviewer') a.alive = false; // its process ended meanwhile
  manifest('B');
  assert.equal(h.run(), 0);
  const reviewers = p.events().filter((e) => e.type === 'agent_start' && e.role === 'reviewer');
  assert.deepEqual(reviewers.map((e) => [e.resumedSession, e.setup.commit]), [[false, 'A'], [true, 'A']]);
  assert.equal(p.events().filter((e) => e.type === 'run_start').at(-1).setup.commit, 'B', 'the relay code is the new install');
});
