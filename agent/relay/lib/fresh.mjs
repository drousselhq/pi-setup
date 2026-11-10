// pi-relay: Replacing the waiting worker with a fresh session, on the owner's request (--fresh <role>).
//
// A worker can get stuck in a way only a new session fixes: it saw material it must not see, or it is
// confused beyond repair. The owner stops the relay and re-runs it with --fresh <role>. The relay closes
// that worker's tab, forgets its session and restarts its current step in a new session, with the
// owner's optional --note. A fresh reviewer does a full, independent review: the previous review record
// is set aside in relay/ (kept for the owner, not given to the new reviewer). Other roles keep their
// record, as a senior implementer does when it takes over. After a compaction-limit stop, the queued retry
// of that step is replaced the same way.

import fs from 'node:fs';
import path from 'node:path';
import { moveStepCounts } from './advisor.mjs';
import { closeTabs, releaseAgent } from './agents.mjs';
import { C, emit, event, log } from './console.mjs';
import { ctx, RelayStop, state } from './runtime.mjs';
import { artifactPath, queue } from './steps.mjs';
import { reviewMessage } from './transitions.mjs';

const REPLACEABLE = ['planner', 'scout', 'architect', 'acceptance', 'implementer', 'senior', 'reviewer'];

export function replaceWorker(role, note) {
  const c = state.cur;
  if (!REPLACEABLE.includes(role)) throw new RelayStop(`--fresh takes a worker role (${REPLACEABLE.join(', ')}), not "${role}".`);
  const p = c?.pending ?? (c?.queued?.retryOf === 'runaway' ? c.queued : null);
  if (!p || p.role !== role) {
    throw new RelayStop(`--fresh ${role}: the ${role} has no step in progress${p ? ` (the waiting step is the ${p.role}'s)` : ''}. `
      + 'It applies to the worker the relay is waiting for, or to the step retried after a compaction-limit stop.');
  }
  releaseAgent(role); // forgets the session, so the next start is a new one; its tab closes below
  let setAside = null;
  let { text, purpose } = p;
  if (role === 'reviewer') {
    const record = artifactPath('reviewer', c.slice);
    if (fs.existsSync(record)) {
      setAside = path.join(ctx.relayDir, `${String(++state.seq).padStart(3, '0')}-reviewer-replaced-review.md`);
    }
    if (p.purpose !== 'review') { c.reviewed = false; ({ text, purpose } = reviewMessage()); } // a fresh reviewer reviews in full
  }
  moveStepCounts(p, { role, purpose });
  const why = role === 'reviewer'
    ? 'The owner replaced the previous reviewer session for this step: do a full, independent review from the assignment.'
    : `The owner replaced the previous ${role} session for this step; its record is ${artifactPath(role, c.slice)}. `
      + 'Check the repository state before continuing.';
  c.pending = null;
  // Saved with the release, before the record moves: send() moves it before the new reviewer starts, so a
  // kill in between cannot give the new session the old record.
  const moveRecord = setAside ? { from: artifactPath('reviewer', c.slice), to: setAside } : undefined;
  queue({ role, purpose, initial: true, retryOf: p.retryOf, moveRecord, text: `${why}${note ? `\n\nThe owner's note: ${note}` : ''}\n\n${text}` });
  moveAside(moveRecord);
  closeTabs();
  emit('fresh_session', { role, purpose, setAside, note: note ?? null });
  log(`${c.slice} ${role} replaced by a fresh session at the owner's request${setAside ? `; previous review record set aside in ${setAside}` : ''}`, { quiet: true });
  event(C.yellow('\u21bb'), `${C.yellow(`${role} replaced by a fresh session`)} ${C.dim('\u00b7 at your request')}`,
    setAside ? `Previous review record kept in ${path.relative(ctx.project, setAside)}.` : '');
}

// Moves a replaced reviewer's record aside unless already done (idempotent; send() calls it again).
export function moveAside(move) {
  if (move && fs.existsSync(move.from) && !fs.existsSync(move.to)) fs.renameSync(move.from, move.to);
}
