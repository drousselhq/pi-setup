// Kill sweep (faults.mjs) over a preparation chain: scout, architect and acceptance tests before the implementer.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sweep } from './faults.mjs';
import { done, standard } from './harness.mjs';

const TESTS = ['tests/accept_a.txt', 'tests/accept_b.txt'];

test('kill sweep: scout, architect and acceptance tests before the implementer', { timeout: 600_000 }, () => {
  sweep({
    name: 'prep',
    plan: '# Plan\n\n## S1: Only\nNeeds: scout, architecture, acceptance\nAcceptance:\n- x\n',
    worker(c, { p }) {
      if (c.role === 'acceptance') {
        for (const t of TESTS) {
          fs.mkdirSync(path.dirname(path.join(p.project, t)), { recursive: true });
          fs.writeFileSync(path.join(p.project, t), `${t}\n`);
        }
        return c.write(done('tests written', { tests: TESTS }));
      }
      if (c.role === 'implementer' && c.slice === 'S1') {
        if (!fs.existsSync(path.join(p.project, 's1.txt'))) {
          fs.writeFileSync(path.join(p.project, 's1.txt'), 's1\n');
          p.git('add', 's1.txt', ...TESTS.filter((t) => fs.existsSync(path.join(p.project, t))));
          p.git('commit', '-q', '-m', 'S1');
        }
        return c.write(done());
      }
      return standard(c);
    },
  });
});
