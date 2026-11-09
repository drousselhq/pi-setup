// Kill sweep (faults.mjs) over the ordinary flow: planning, a scout question, a review loop, escalation to the
// senior and the final verification. Workers react to the repository's state, not to how often they were
// prompted, so a restarted scenario stays consistent.
import fs from 'node:fs';
import { test } from 'node:test';
import { sweep } from './faults.mjs';
import { accept, changes, done } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';

test('kill sweep: planner, scout question, review loop, escalation, final verification', { timeout: 600_000 }, () => {
  sweep({
    name: 'flow',
    config: { escalation: { enabled: true, afterLoops: 2, onRecurringFinding: false, maxLoops: 2 } },
    worker(c, { p }) {
      const has = (f) => fs.existsSync(`${p.project}/${f}`);
      const fixes = () => ['fix-1.txt', 'fix-2.txt', 'fix-3.txt'].filter(has).length;
      if (c.role === 'planner') { fs.writeFileSync(p.file('plan.md'), ONE); return c.write(done('planned')); }
      if (c.role === 'scout') { fs.writeFileSync(p.file('slices/S1/scout.md'), 'facts\n'); return c.write(done('answered')); }
      if (c.role === 'reviewer') return c.write(fixes() >= 2 ? accept() : changes('R1'));
      if (c.slice === 'FINAL') return c.write(done('verified', { verification: 'pass' }));
      if (!fs.existsSync(p.file('slices/S1/scout.md'))) return c.write({ status: 'needs-scout', summary: 'lost', question: 'Where is X?' });
      if (!has('s1.txt')) p.commit('s1.txt');
      if (/fix the blocking findings/.test(c.text) && fixes() < 3) p.commit(`fix-${fixes() + 1}.txt`);
      return c.write(done('done'));
    },
  });
});
