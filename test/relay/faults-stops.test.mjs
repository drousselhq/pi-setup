// Kill sweep (faults.mjs) over stops: a compaction-limit stop retried by a plain re-run and by --fresh, and a
// failing final verification retried after the owner fixed the cause.
import fs from 'node:fs';
import { test } from 'node:test';
import { sweep } from './faults.mjs';
import { TOPIC, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const worker = (c, { p }) => {
  const marker = `${p.root}/reviewer-ran-away`;
  if (c.role === 'reviewer' && !fs.existsSync(marker)) { // once: too many compactions, no result
    fs.writeFileSync(marker, '');
    fs.writeFileSync(p.file('slices/S1/review.md'), 'partial notes\n');
    fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n');
    return undefined;
  }
  if ((c.role === 'implementer' || c.role === 'senior') && c.slice === 'S1') {
    if (!fs.existsSync(`${p.project}/s1.txt`)) p.commit('s1.txt');
    return c.write({ status: 'done', summary: 'done', checks: ['fake → pass'] });
  }
  return standard(c);
};

test('kill sweep: a compaction-limit stop retried by a plain re-run', { timeout: 600_000 }, () => {
  sweep({ name: 'stop-retry', plan: ONE, config: { escalation: { enabled: false } }, worker });
});

test('kill sweep: a compaction-limit stop retried with --fresh', { timeout: 600_000 }, () => {
  sweep({ name: 'stop-fresh', plan: ONE, config: { escalation: { enabled: false } }, worker, afterStop: [TOPIC, '--fresh', 'reviewer', '--note', 'Start over.'] });
});

test('kill sweep: a failing final verification retried after a re-run', { timeout: 600_000 }, () => {
  sweep({
    name: 'final-fail',
    plan: ONE,
    worker(c, { p }) {
      const marker = `${p.root}/final-failed-once`;
      if (c.role === 'implementer' && c.slice === 'FINAL') {
        if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ''); return c.write({ status: 'done', summary: '2 tests fail', verification: 'fail', checks: ['npm test → fail'] }); }
        return c.write({ status: 'done', summary: 'verified', verification: 'pass', checks: ['npm test → pass'] });
      }
      return c.role === 'reviewer' ? standard(c) : worker(c, { p }); // an ordinary reviewer here
    },
  });
});
