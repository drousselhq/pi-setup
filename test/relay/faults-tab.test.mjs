// Kill sweep (faults.mjs) over an answer typed in a blocked worker's tab, recorded once in decisions.md.
import fs from 'node:fs';
import { test } from 'node:test';
import { sweep } from './faults.mjs';
import { accept, standard, writeResult } from './harness.mjs';

test('kill sweep: an answer typed in a blocked reviewer\'s tab', { timeout: 600_000 }, () => {
  const ref = sweep({
    name: 'tab-answer',
    plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n',
    worker(c, { p }) {
      const answered = `${p.root}/owner-answered`;
      if (c.role === 'reviewer' && !fs.existsSync(answered)) {
        c.write({ status: 'blocked', summary: 'stuck', question: 'May I read the b files?' });
        return c.later(() => {
          if (fs.existsSync(answered)) return;
          fs.writeFileSync(answered, '');
          c.type('Yes, read them; write nothing there.');
          writeResult(c.resultPath, accept(), { after: c.resultPath });
        });
      }
      return standard(c);
    },
  });
  if (!/## Tab answer[\s\S]*> Yes, read them; write nothing there\./.test(ref.decisions)) throw new Error(`the scenario must record the tab answer:\n${ref.decisions}`);
});
