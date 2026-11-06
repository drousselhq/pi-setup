// pi-relay: What happens after each result: the next step, review loops, escalation, finishing a slice.

import { acceptanceStep, implementerNote, PREP_ORDER, recordAcceptance, reviewerNote } from './acceptance.mjs';
import { closeAgent, closeAll } from './agents.mjs';
import { sliceChanged } from './changes.mjs';
import { C, compactionText, emit, event, fmtDuration, GUTTER, log, out, resultIcon, resultLabel, roleTag, shortModel } from './console.mjs';
import { FINAL_SLICE, parsePlan, PLAN_FORMAT, PLAN_SLICE, progress, progressText } from './plan.mjs';
import { cfg, ctx, git, HELP_STATUSES, now, plural, RelayStop, state } from './runtime.mjs';
import { artifactPath, queue } from './steps.mjs';
import { save } from './store.mjs';
import { stepUsage } from './usage.mjs';

export function currentSlice() {
  const id = state.cur.slice;
  if (id === 'PLAN') return PLAN_SLICE;
  if (id === 'FINAL') return FINAL_SLICE;
  const s = parsePlan().find((x) => x.id === id);
  if (!s) throw new RelayStop(`Slice ${id} disappeared from plan.md. Restore it or remove relay/state.json "cur".`);
  return s;
}

export function firstMessage(slice) {
  const roles = slice.needs.map((n) => (n === 'architecture' ? 'architect' : n));
  const prep = PREP_ORDER.filter((r) => roles.includes(r)); // fixed order: acceptance tests bind to the architect's interfaces
  state.cur.prep = prep;
  if (slice.id === 'PLAN') {
    return { role: 'planner', purpose: 'plan', initial: true, text: `Break the handoff into slices and write ${ctx.plan} in the relay plan format:\n\n${PLAN_FORMAT}\n\n`
      + 'Use exactly `## S<n>: title` headings. `Needs:` is `none`, or any of `scout`, `architecture` and `acceptance` for '
      + 'preparation that runs before implementation. The relay counts the `Acceptance:` bullets.' };
  }
  if (prep.length) return prepMessage(prep[0], slice);
  return implementMessage(slice);
}

export function prepMessage(role, slice) {
  if (role === 'acceptance') return acceptanceStep(slice);
  return role === 'scout'
    ? { role, purpose: 'prep', initial: true, text: `Establish the repository facts the implementer needs for slice ${slice.id}.` }
    : { role, purpose: 'prep', initial: true, text: `Settle the consequential design for slice ${slice.id} before implementation.` };
}

export function implementMessage(slice) {
  return slice.id === 'FINAL'
    ? { role: 'implementer', purpose: 'final', initial: true, text: FINAL_SLICE.body + ' Report in "checks" exactly what ran and its result.' }
    : { role: 'implementer', purpose: 'implement', initial: true, text: `Implement slice ${slice.id} until its acceptance is met and focused checks pass.${implementerNote()}` };
}

export function reviewMessage() {
  const c = state.cur;
  const candidate = cfg.commit ? `commits ${c.base}..HEAD` : `the working-tree changes since ${c.base}`;
  if (!c.reviewed) {
    return {
      role: 'reviewer', purpose: 'review', initial: true,
      text: `Review the implementation of this slice: ${candidate} (exclude the pre-existing changes listed above). `
        + 'Set verdict "accept" when the slice acceptance is met with no blocking finding. '
        + 'A finding is blocking only if it violates the slice acceptance, the handoff or a project contract, or has a concrete material consequence. '
        + 'Everything else is non-blocking: record it, but do not list it in "blocking".' + reviewerNote(),
    };
  }
  return {
    role: 'reviewer', purpose: `rereview${c.cycle}`,
    text: `The ${c.senior ? 'senior implementer' : 'implementer'} addressed findings ${c.findings.join(', ') || '(see review)'}; the candidate is now ${candidate}. `
      + 'Re-review those repairs and their adjacent regression risk only; do not restart a full audit. Update your review and verdict.'
      + reviewerNote(),
  };
}

// ---------- escalation ----------
// After repeated review loops (or a returning finding, or a runaway implementer step), a senior
// implementer takes over the slice in a fresh session for a bounded number of review loops.

export const escalationCfg = () => (cfg.escalation && cfg.escalation.enabled !== false ? cfg.escalation : null);

export const implRole = () => (state.cur?.senior ? 'senior' : 'implementer');

// Repair attempts allowed before the relay stops for the operator (the next rejection beyond it stops).
export function repairLimit(c) {
  const e = escalationCfg();
  const extra = c.extraCycles ?? 0;
  if (!e) return (cfg.maxRepairCycles ?? 3) + extra;
  const before = c.senior ? c.juniorRepairs : (e.afterLoops ?? 2) - 1;
  return before + (e.maxLoops ?? 2) + extra;
}

export function escalate(reason, step) {
  const c = state.cur;
  const slice = currentSlice();
  c.senior = true;
  c.juniorRepairs = c.cycle - (String(step.purpose).startsWith('repair') ? 1 : 0);
  c.escalation = reason;
  // The successor and the closed worker are saved together: an interruption in between must not lose the step.
  c.queued = {
    role: 'senior', purpose: step.purpose, initial: true,
    text: `You are the senior implementer taking over this slice: ${reason}. The previous implementer's work is in the `
      + `repository (commits since the slice base and any uncommitted changes) and in ${artifactPath('implementer', slice.id)}; `
      + 'its session is not available to you. Before patching again, check whether the approach itself is wrong; you may rework '
      + `this slice's changes within its scope. Then complete this step:\n\n${step.text}${implementerNote()}`,
  };
  closeAgent('implementer');
  save();
  const rc = cfg.roles?.senior ?? {};
  emit('escalation', { from: 'implementer', to: 'senior', reason, reviewLoops: c.cycle, model: rc.model ?? null, thinking: rc.thinking ?? null });
  log(`${slice.id} escalated to senior implementer: ${reason}`, { quiet: true });
  event(C.yellow('\u21e7'), `${C.yellow(C.bold('escalated to senior implementer'))} ${C.gray(`\u00b7 ${shortModel(rc.model)} ${rc.thinking ?? 'medium'}`)}`, reason);
}

export function stopOnRunaway(p, r, slice) {
  const c = state.cur;
  if (p.role === 'implementer' && escalationCfg()) {
    return escalate(`the implementer was stopped after ${plural(p.runaway.compactions, 'compaction')} in one step`, { purpose: p.purpose, text: p.text });
  }
  // A re-run retries in a fresh session; --fresh can replace this retry (retryOf). Saved together with the
  // closed worker, so an interruption in between cannot lose the step.
  c.queued = { role: p.role, purpose: p.purpose, initial: true, text: p.text, retryOf: 'runaway' };
  closeAgent(p.role);
  save();
  const fresh = `pi-relay ${ctx.topic} --fresh ${p.role} --note "..."`;
  const planning = ['PLAN', 'FINAL'].includes(slice.id) ? '' // not a slice of plan.md
    : sliceChanged()
      ? ` ${slice.id} already has commits or changes, so no slice can be inserted before it: work that does not belong in this `
        + 'step can move to a new slice after it in plan.md, but this slice must still meet its acceptance conditions.'
      : ` If the slice is too big, split it in plan.md first (${slice.id} has no commits or changes yet).`;
  throw new RelayStop(`${slice.id}: the ${p.role} was interrupted after ${p.runaway.compactions} compactions in one step `
    + `(limit ${cfg.maxCompactionsPerStep ?? 3}). The step is probably too big, or the worker is going in circles. Its partial work `
    + `is in the working tree and its session file is kept. Re-running pi-relay ${ctx.topic} retries this step in a fresh session `
    + `that continues from that work. To steer the retry instead, use ${fresh}`
    + (p.role === 'reviewer' ? ' (the partial review record is then set aside and the new reviewer reviews in full)' : '')
    + `.${planning}`);
}

// Applies a worker's result. If the transition fails before it has recorded a successor (a next step
// or the end of the slice), the result stays pending, so a restart replays the transition from that
// result instead of finding no next step (see collect(), which reads a finished result directly).
export function transition(r) {
  const c = state.cur;
  const p = c.pending;
  const compactions = c.compactions;
  try {
    applyResult(c, p, r);
  } catch (e) {
    if (state.cur === c && !c.pending && !c.queued) {
      c.pending = p;
      c.compactions = compactions;
      save();
    }
    throw e;
  }
}

function applyResult(c, p, r) {
  c.pending = null;
  const slice = currentSlice();
  const usage = stepUsage(p);
  if (usage) c.compactions = (c.compactions ?? 0) + usage.compactions;
  emit('step_result', {
    role: p.role, purpose: p.purpose, status: r.status, verdict: r.verdict ?? null,
    blocking: Array.isArray(r.blocking) ? r.blocking : null, summary: r.summary ?? null, question: r.question ?? null,
    checks: r.checks ?? null, durationMs: Date.now() - (p.firstSentAt ?? p.sentAt),
    usage,
  });
  log(`${slice.id} ← ${p.role} ${r.status}${r.verdict ? ` (${r.verdict})` : ''}: ${r.summary ?? ''}`, { quiet: true });
  const facts = [];
  if (r.verdict === 'changes-required') {
    facts.push(C.yellow(`review loop ${c.cycle + 1}/${repairLimit(c) + 1}`));
    const again = (Array.isArray(r.blocking) ? r.blocking : []).filter((id) => (c.findings ?? []).includes(id));
    if (again.length) facts.push(C.red(`${again.join(', ')} again`));
  }
  if (usage) facts.push(C.gray(plural(usage.turns, 'turn')), compactionText(usage.compactions));
  event(resultIcon(r), `${roleTag(p.role)} ${resultLabel(r)}${facts.length ? ` ${C.gray('\u00b7')} ${facts.join(C.gray(' \u00b7 '))}` : ''}`,
    [r.summary, r.question && `Question: ${r.question}`].filter(Boolean).join('\n'));

  if (r.status === 'runaway') return stopOnRunaway(p, r, slice);

  if (HELP_STATUSES[r.status]) {
    c.returnTo = { role: p.role, purpose: p.purpose };
    const helper = HELP_STATUSES[r.status];
    queue({ role: helper, purpose: 'help', initial: true, text: `Answer this question from the ${p.role}, in your artifact: ${r.question}` });
    const limit = (cfg.maxHelpRequests ?? 2) + (c.extraHelp ?? 0);
    if (++c.help > limit) {
      c.extraHelp = (c.extraHelp ?? 0) + (cfg.maxHelpRequests ?? 2);
      save();
      throw new RelayStop(`${slice.id}: more than ${limit} scout/architect requests; this slice is probably badly scoped. `
        + `Last question: ${r.question}. Re-running pi-relay ${ctx.topic} answers it and allows more; or edit plan.md first.`);
    }
    return;
  }

  if (p.purpose === 'help') {
    closeAgent(p.role);
    const back = c.returnTo;
    c.returnTo = null;
    return queue({ ...back, initial: false, text: `The ${p.role} answered your question in ${r.artifact ?? artifactPath(p.role, slice.id)}. Read it and continue your current step.` });
  }

  if (p.role === 'planner') {
    closeAgent('planner');
    const slices = parsePlan();
    if (!slices.length) {
      throw new RelayStop(`The planner finished but ${ctx.plan} has no "## S1: ..." slices. Fix plan.md, then start pi-relay ${ctx.topic} again.`);
    }
    log(`PLAN has ${slices.length} slices: ${slices.map((s) => s.id).join(', ')}`, { quiet: true });
    event(C.green('\u2713'), `${C.bold(`plan: ${slices.length} slice${slices.length === 1 ? '' : 's'}`)}`, slices.map((s) => `${s.id}  ${s.title}${s.needs.length ? `  [${s.needs.join(', ')}]` : ''}`).join('\n'));
    return finishSlice();
  }

  if (p.purpose === 'prep') {
    if (p.role === 'acceptance' && r.status === 'done') recordAcceptance(slice.id, r);
    c.prep.shift();
    queue(c.prep.length ? prepMessage(c.prep[0], slice) : implementMessage(slice));
    return closeAgent(p.role);
  }

  if (p.role === 'implementer' || p.role === 'senior') {
    if (slice.id === 'FINAL' && !c.reviewed && !sliceChanged()) return finishSlice();
    return queue(reviewMessage());
  }

  if (p.role === 'reviewer') {
    c.reviewed = true;
    if (r.verdict === 'accept') return finishSlice();
    const blocking = Array.isArray(r.blocking) ? r.blocking : [];
    const again = blocking.filter((id) => (c.findings ?? []).includes(id));
    c.findings = blocking;
    c.cycle++;
    const repair = {
      purpose: `repair${c.cycle}`,
      text: `Review loop ${c.cycle}: fix the blocking findings ${c.findings.join(', ') || '(see review)'} in ${r.artifact ?? artifactPath('reviewer', slice.id)}. `
        + 'Verify each one first; if you disagree, explain with evidence in your artifact instead of changing code. Run focused checks.',
    };
    const e = escalationCfg();
    if (e && !c.senior && (c.cycle >= (e.afterLoops ?? 2) || (e.onRecurringFinding !== false && again.length))) {
      return escalate(`${plural(c.cycle, 'review loop')} without acceptance${again.length ? `; ${again.join(', ')} came back after a repair` : ''}`, repair);
    }
    queue({ role: implRole(), ...repair });
    if (c.cycle > repairLimit(c)) {
      const more = e ? (e.maxLoops ?? 2) : (cfg.maxRepairCycles ?? 3);
      c.extraCycles = (c.extraCycles ?? 0) + more;
      save();
      throw new RelayStop(`${slice.id}: still not accepted after ${plural(c.cycle, 'review loop')}${c.senior ? ', including the senior implementer' : ''}. `
        + `Read ${artifactPath('reviewer', slice.id)}. Re-running pi-relay ${ctx.topic} allows ${more} more; or edit plan.md/handoff.md first.`);
    }
  }
}

export function finishSlice() {
  const c = state.cur;
  closeAll();
  const head = git(['rev-parse', 'HEAD']);
  const commits = c.base && head && head !== c.base ? git(['log', '--format=%h %s', `${c.base}..HEAD`]) : '';
  state.slices[c.slice] = {
    status: 'done', base: c.base, head, cycles: c.cycle, compactions: c.compactions ?? 0,
    escalated: c.senior ? c.escalation : null, finishedAt: now(),
  };
  log(`${c.slice} done${commits ? `; commits:\n    ${commits.split('\n').join('\n    ')}` : ''}`, { quiet: true });
  const n = commits ? commits.split('\n').length : 0;
  emit('slice_done', {
    base: c.base, head, commits: commits ? commits.split('\n') : [], repairCycles: c.cycle, helpRequests: c.help, compactions: c.compactions ?? 0, escalated: Boolean(c.senior),
    durationMs: c.startedAt ? Date.now() - c.startedAt : null,
  });
  const facts = [
    n ? `${n} commit${n > 1 ? 's' : ''}` : 'no commits',
    plural(c.cycle, 'review loop'),
    plural(c.compactions ?? 0, 'compaction'),
    c.senior ? 'escalated to senior' : null,
    c.startedAt ? fmtDuration(Date.now() - c.startedAt) : null,
  ].filter(Boolean).join(' \u00b7 ');
  event(C.green('\u25cf'), `${C.green(C.bold(`${c.slice} done`))} ${C.gray(`\u00b7 ${facts}`)}`);
  if (commits) out(commits.split('\n').map((l) => `${' '.repeat(GUTTER)}${C.yellow(l.slice(0, 7))} ${l.slice(8)}`).join('\n'));
  if (c.slice !== 'PLAN') {
    state.cur = null; // totals now come from finished slices only
    event(C.cyan('\u25b8'), `${C.bold('progress')} ${C.gray('\u00b7')} ${progressText(progress())}`);
    state.cur = c;
  }
  state.cur = null;
  save();
}

// ---------- main loop ----------
