// Kill sweep (faults.mjs) over a prerequisite slice chosen for an untouched slice: it is set aside and resumes.
import fs from 'node:fs';
import { test } from 'node:test';
import { sweep } from './faults.mjs';
import { brief, decision, done, standard } from './harness.mjs';

test('kill sweep: a prerequisite slice chosen for an untouched slice, which is set aside and resumes', { timeout: 600_000 }, () => {
  const ref = sweep({
    name: 'set-aside',
    plan: '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- one\n\n## S2: Second\nNeeds: none\nAcceptance:\n- two\n',
    worker(c, { p }) {
      const decided = (id) => fs.existsSync(p.file('decisions.md')) && new RegExp(`^## ${id} `, 'm').test(p.read('decisions.md'));
      const ask = () => c.write({ status: 'needs-decision', summary: 'a choice', question: 'Prepare first?', options: [{ label: 'Prepare first', consequence: 'p' }, { label: 'Go on', consequence: 'g' }], recommended: 1, reason: 'r' });
      if (c.role === 'implementer' && c.slice === 'S2' && !decided('D1')) return ask();
      if (c.role === 'implementer' || c.role === 'senior') {
        if (!fs.existsSync(`${p.project}/${c.slice}.txt`)) p.commit(`${c.slice}.txt`);
        return c.write(done());
      }
      if (c.role === 'advisor') {
        c.write(brief());
        return c.answer(decision({ slice: { title: 'Make the fixture', acceptance: ['the fixture exists'] } }));
      }
      return standard(c);
    },
  });
  if (ref.slices.join(' ') !== 'FINAL S1 S1B S2') throw new Error(`unexpected slices ${ref.slices.join(' ')}`);
});
