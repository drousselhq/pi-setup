// Kill sweep (faults.mjs) over decisions: an owner decision through the advisor (S1) and a council decision (S2).
import fs from 'node:fs';
import { test } from 'node:test';
import { sweep } from './faults.mjs';
import { brief, decision, done, standard } from './harness.mjs';

const ROLES = Object.fromEntries(['planner', 'scout', 'architect', 'implementer', 'senior', 'reviewer', 'advisor', 'council1', 'council2']
  .map((r) => [r, { model: `test/${r}`, thinking: 'low' }]));
const OPTIONS = [
  { label: 'B: fix both', consequence: 'both fixed', action: 'Fix the weight bug completely.', classes: ['A'] },
  { label: 'A: fix one', consequence: 'one fixed', action: 'Fix only the undefined part.', classes: ['A'] },
];
const vote = (role) => ({ status: 'done', choice: 'X2', conditions: [`${role}: keep the old fixture`], classes: ['A'], ownerNeeded: null,
  confidence: 'high', reversibility: 'easy', reasons: 'the evidence', objection: 'none decisive', ownerSummary: 'I would fix both.' });
// Replies of several lines: the sweep compares what workers received whole.
const ownerAnswer = decision({ replies: { implementer: 'Proceed with A.\nKeep the old fixture.', reviewer: 'Check A.\nAlso check the fixture.' } });

test('kill sweep: an owner decision and a council decision', { timeout: 600_000 }, () => {
  const ref = sweep({
    name: 'decisions',
    plan: '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- one\n\n## S2: Second\nNeeds: none\nAcceptance:\n- two\n',
    config: { roles: ROLES, council: { enabled: true, members: ['council1', 'council2'] } },
    worker(c, { p }) {
      const decided = (id) => fs.existsSync(p.file('decisions.md')) && new RegExp(`^## ${id} `, 'm').test(p.read('decisions.md'));
      if (c.role === 'implementer' && (c.slice === 'S1' || c.slice === 'S2')) {
        if (!decided(c.slice === 'S1' ? 'D1' : 'D2')) {
          return c.write({ status: 'needs-decision', summary: 'a choice', question: 'Which fix?', options: [{ label: 'Fix both', consequence: 'b' }, { label: 'Fix one', consequence: 'a' }], recommended: 1, reason: 'r' });
        }
        if (!fs.existsSync(`${p.project}/${c.slice}.txt`)) p.commit(`${c.slice}.txt`);
        return c.write(done());
      }
      if (c.role === 'advisor') {
        if (c.slice === 'S1') { c.write(brief({ options: OPTIONS, ownerNeeded: 'the owner prefers to decide this' })); return c.answer(ownerAnswer); }
        return c.write(brief({ options: OPTIONS, ownerNeeded: null }));
      }
      if (c.role === 'council1' || c.role === 'council2') return c.write(vote(c.role));
      return standard(c);
    },
  });
  const ids = ref.decisions.match(/^## D\d+ /gm) ?? [];
  if (ids.join('') !== '## D1 ## D2 ') throw new Error(`expected decisions D1 and D2, got ${ids.join(' ')}`);
  const got = [...ref.delivered].join('\n');
  // The council's binding reply is the relay's, built from the votes: the members' conditions must reach the worker.
  for (const line of ['Keep the old fixture.', 'council1: keep the old fixture', 'council2: keep the old fixture', 'Also check the fixture.']) {
    if (!got.includes(line)) throw new Error(`the scenario should deliver "${line}"; delivered:\n${got}`);
  }
});
