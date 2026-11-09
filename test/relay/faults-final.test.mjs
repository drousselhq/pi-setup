// Kill sweep (faults.mjs) over a prerequisite slice chosen during a final verification that changed nothing:
// it is appended to the plan, runs, and the final verification starts again.
import fs from 'node:fs';
import { test } from 'node:test';
import { sweep } from './faults.mjs';
import { brief, decision, done, standard } from './harness.mjs';

test('kill sweep: a prerequisite slice chosen during the final verification', { timeout: 600_000 }, () => {
  const ref = sweep({
    name: 'final-prerequisite',
    plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- one\n',
    worker(c, { p }) {
      const decided = fs.existsSync(p.file('decisions.md')) && /^## D1 /m.test(p.read('decisions.md'));
      if (c.role === 'implementer' && c.slice === 'FINAL') {
        if (decided) return c.write(done('verified', { verification: 'pass' }));
        return c.write({ status: 'needs-decision', summary: 'a choice', question: 'Add a fixture first?', options: [{ label: 'Add it first', consequence: 'p' }, { label: 'Go on', consequence: 'g' }], recommended: 1, reason: 'r' });
      }
      if (c.role === 'implementer' || c.role === 'senior') {
        if (!fs.existsSync(`${p.project}/${c.slice}.txt`)) p.commit(`${c.slice}.txt`);
        return c.write(done());
      }
      if (c.role === 'advisor') { c.write(brief()); return c.answer(decision({ slice: { title: 'Add the missing fixture', acceptance: ['the fixture exists'] } })); }
      return standard(c);
    },
  });
  if (ref.slices.join(' ') !== 'FINAL S1 S1B') throw new Error(`unexpected slices ${ref.slices.join(' ')}`);
});
