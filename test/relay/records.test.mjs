// What the relay's records keep for later evaluation (the whole brief, the option chosen, the slice a decision
// belongs to), and what workers are told about asking.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeHerdr, brief, decision, makeProject, standard } from './harness.mjs';

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
