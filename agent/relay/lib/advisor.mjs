// pi-relay: The advisor: plain-language decision briefs for the owner, recorded decisions and replies.

import fs from 'node:fs';
import { agentAlive, closeAgent, ensureAgent } from './agents.mjs';
import { C, callout, emit, event, log, roleTag } from './console.mjs';
import { run } from './io.mjs';
import { insertPrerequisite, setAside } from './prerequisites.mjs';
import { quotaGate } from './quota.mjs';
import { cfg, ctx, notify, RelayStop, state } from './runtime.mjs';
import {
  artifactPath, DEFERRAL_FIELDS, prompt, readResult, resultPathFor, settle, showQuestion, valid, validDeferral, waitForOperator, writeAssignment,
} from './steps.mjs';
import { save } from './store.mjs';
import { currentSlice, sliceChanged } from './transitions.mjs';

export const advisorEnabled = () => cfg.advisor?.enabled !== false && Boolean(cfg.roles?.advisor?.model);

// Labels that postpone the decision; such an option must carry a complete deferral.
const POSTPONES = new RegExp('\\b(defer\\w*|postpon\\w*|later|revisit\\w*|investigat\\w*|for now)\\b', 'i');

// What is wrong with a brief, as an instruction to the advisor; null when it can be shown.
function briefProblem(b) {
  if (!b) return 'You stopped without writing the brief.';
  if (b.status === 'invalid') return `Your brief file is invalid (${b.summary}).`;
  if (b.status !== 'needs-decision') return null;
  const options = b.brief?.options;
  if (!b.brief?.question || !Array.isArray(options)) return 'Your brief is incomplete: it needs at least a question and options.';
  if (Number(b.brief.recommended) !== 1) return 'Your brief must list the recommended option first and set "recommended" to 1.';
  const bad = options.findIndex((o) => (o?.deferral || POSTPONES.test(o?.label ?? '')) && !validDeferral(o?.deferral));
  if (bad >= 0) {
    return `Option ${bad + 1} postpones the decision but does not state its "deferral" (missing, source, decisionPoint, interim). `
      + 'Give all four, or, if you cannot, replace it with a concrete answer: do not offer it as a postponement.';
  }
  return null;
}

export function showBrief(agent, r) {
  if (!r.brief) return showQuestion(agent, r); // e.g. the advisor itself reports blocked
  const b = r.brief;
  const rec = Number(b.recommended) || 0;
  const options = Array.isArray(b.options) ? b.options : [];
  log(`${state.cur.slice} decision needed: ${b.title} \u2014 ${b.question}`, { quiet: true });
  notify(`Relay ${ctx.topic}: decision needed`, `${b.title}${rec && options[rec - 1] ? `\n\u2605 ${rec}. ${options[rec - 1].label}` : ''}`);
  callout(C.magenta, `Decision needed: ${b.title}`, [
    b.question,
    b.context && C.dim(b.context),
    ...options.flatMap((o, i) => [
      `${i + 1 === rec ? C.yellow('\u2605') : ' '} ${i + 1}. ${o.label}${o.consequence ? C.dim(` \u2014 ${o.consequence}`) : ''}`,
      ...(o.deferral ? Object.entries(DEFERRAL_FIELDS).map(([k, name]) => C.dim(`      ${name}: ${o.deferral[k]}`)) : []),
    ]),
    rec && b.reason ? `${C.yellow('\u2605')} ${C.dim(`Recommended: ${b.reason}`)}` : null,
    ...(Array.isArray(b.notes) ? b.notes : []).filter(Boolean).map((n) => C.dim(`Note: ${n}`)),
    C.dim(`Answer in tab "${agent.label}". A number is enough; you can also ask it questions.`),
  ]);
}

export function recordDecision(slice, final) {
  const header = `# Owner decisions: ${ctx.topic}\n\nRecorded by pi-relay from the owner's answers. Every worker reads this file.\n`;
  const text = fs.existsSync(ctx.decisions) ? fs.readFileSync(ctx.decisions, 'utf8') : header;
  const id = `D${(text.match(/^## D\d+/gm) ?? []).length + 1}`;
  const title = String(final.title ?? 'Decision').replace(/\s+/g, ' ').trim();
  const deferral = final.deferral
    ? `\n**Deferred.**\n${Object.entries(DEFERRAL_FIELDS).map(([k, name]) => `- ${name}: ${String(final.deferral[k]).trim()}`).join('\n')}\n` : '';
  fs.writeFileSync(ctx.decisions, `${text.trimEnd()}\n\n## ${id} \u00b7 ${new Date().toISOString().slice(0, 10)} \u00b7 ${slice.id} \u00b7 ${title}\n\n${final.decision.trim()}\n${deferral}`);
  return { id, title };
}

// Returns true when the waiting worker has received the owner's decision; false to fall back to
// asking the owner directly in the worker's tab.
export function consultAdvisor(worker, p, r) {
  const c = state.cur;
  const slice = currentSlice();
  const fallback = (why, what = 'could not prepare a brief') => {
    log(`${slice.id} advisor unavailable (${why}); asking the owner directly`, { quiet: true });
    event(C.yellow('\u26a0'), `${roleTag('advisor')} ${C.yellow(what)} ${C.dim(`\u00b7 ${why}; asking you directly`)}`);
    closeAgent('advisor');
    c.advice = null;
    save();
    return false;
  };
  let a = c.advice?.workerMtime === r._mtime ? c.advice : null; // resume an advisor already working on this question
  if (!a) {
    closeAgent('advisor');
    a = c.advice = { workerRole: worker.role, workerMtime: r._mtime, briefPath: resultPathFor('advisor', 'brief'), startedAt: Date.now(), sent: 0 };
    c.assignments.advisor = writeAssignment('advisor', 'advise', slice,
      `The ${worker.role} is waiting for the owner. Its result, with its question, is ${r._path}; its record is `
      + `${artifactPath(worker.role, slice.id)}${fs.existsSync(artifactPath(worker.role, slice.id)) ? '' : ' (not written yet; that is normal when it asks early)'}. `
      + `Owner decisions so far: ${ctx.decisions}${fs.existsSync(ctx.decisions) ? '' : ' (none yet)'}; check it for earlier deferrals of the same question. `
      + 'Where the project\'s own instructions (its AGENTS.md or equivalent, and the decision records they point to) define rules for '
      + 'decisions and deferrals, follow them: they take precedence over the defaults of your prompt. Write the brief, wait for the '
      + 'owner to answer in this session, then write the decision and the replies (the waiting worker is the '
      + `${worker.role}). `
      + (sliceChanged()
        ? 'This slice already has commits or changes since it started, so a prerequisite slice cannot be inserted before it: do not offer that option.'
        : 'This slice has no commits or changes yet, so a prerequisite slice can be inserted before it if the owner chooses one.'));
    save();
    emit('advisor_start', { workerRole: worker.role, question: r.question ?? null });
    event(C.magenta('?'), `${roleTag(worker.role)} ${C.magenta('needs a decision')} ${C.dim('\u00b7 asking the advisor for a plain-language brief')}`,
      r.question ?? r.summary ?? '');
  }
  quotaGate('advisor');
  const { agent } = ensureAgent('advisor');
  const askBrief = (text) => { a.sent = Date.now(); save(); settle(agent, prompt(agent, text)); };
  let brief = readResult(a.briefPath, a.startedAt);
  if (!brief && !a.sent) {
    askBrief(`/advise Read and execute the relay assignment at ${c.assignments.advisor}\n\nResult file for this step: ${a.briefPath}`);
  } else if (!brief && agentAlive(agent)?.agent_status === 'working') settle(agent, 'working');
  brief = brief ?? readResult(a.briefPath, a.startedAt);
  const problem = briefProblem(brief);
  if (problem) {
    askBrief(`${problem} Write it to ${a.briefPath} (status "needs-decision") as valid JSON, as your assignment describes, then wait for the owner.`);
    brief = readResult(a.briefPath, a.sent) ?? brief;
  }
  if (!brief) return fallback('no brief written');
  let final = brief;
  if (brief.status === 'needs-decision') {
    if (briefProblem(brief)) return fallback('incomplete brief');
    emit('advisor_brief', { title: brief.brief.title ?? null, options: brief.brief.options.length, recommended: brief.brief.recommended ?? null });
    final = waitForOperator(agent, brief, { show: showBrief, track: false });
    if (final.status === 'invalid' || (final.status === 'done' && !valid('advisor', final))) {
      // A malformed decision file: the owner has answered, so ask once for a corrected file.
      askBrief(`Your result file ${a.briefPath} is invalid (${final.summary ?? 'no decision, or an incomplete slice'}). Rewrite it as valid JSON `
        + 'with status "done", the decision, its title, the replies, if the owner chose one, the slice with a one-line title and '
        + 'at least one acceptance condition, and, if the owner chose to postpone, the deferral with all four fields, as your assignment '
        + 'describes. Do not ask the owner again.');
      final = readResult(a.briefPath, a.sent) ?? final;
    }
  }
  // Never let the advisor decide without the owner: a decision must follow a brief the owner saw.
  if (brief.status !== 'needs-decision' || !valid('advisor', final) || final.status !== 'done') {
    const what = brief.status === 'needs-decision' ? 'could not record your decision' : 'could not prepare a brief';
    return fallback(`unexpected advisor result "${final?.status}"`, what);
  }
  const { id, title } = recordDecision(slice, final);
  emit('owner_decision', { id, title, decision: final.decision, workerRole: worker.role, replies: Object.keys(final.replies ?? {}), slice: final.slice?.title ?? null });
  log(`${slice.id} owner decision ${id}: ${title}`, { quiet: true });
  event(C.green('\u2713'), `${C.green(C.bold(`decision ${id}`))} ${title}`, final.decision);
  closeAgent('advisor');
  c.advice = null;
  if (final.slice) {
    if (sliceChanged()) {
      save();
      throw new RelayStop(`Owner decision ${id} asks for a prerequisite slice ("${final.slice.title}") before ${slice.id}, but ${slice.id} `
        + `already has commits or changes, so the relay cannot set it aside. Add the slice to plan.md where it fits and deal with `
        + `${slice.id}'s changes, then re-run pi-relay ${ctx.topic}. The ${worker.role} is still waiting in its tab.`);
    }
    const pre = insertPrerequisite(slice, final.slice, id);
    setAside(pre, { role: worker.role, purpose: p.purpose, text: `Owner decision ${id} (recorded in ${ctx.decisions}): ${final.replies?.[worker.role] ?? final.decision}` });
    return 'set-aside';
  }
  for (const [role, text] of Object.entries(final.replies ?? {})) {
    if (role === worker.role || !text) continue;
    c.notes = c.notes ?? {};
    c.notes[role] = [c.notes[role], `Owner decision ${id} (${ctx.decisions}): ${text}`].filter(Boolean).join('\n\n');
  }
  const reply = final.replies?.[worker.role] ?? final.decision;
  p.sentAt = Date.now();
  save();
  event(C.cyan('\u2192'), `${roleTag(worker.role)} ${C.dim(`decision ${id} delivered`)}`);
  prompt(worker, `Owner decision ${id} (recorded in ${ctx.decisions}):\n\n${reply}\n\nContinue your current step. `
    + `Write this step's result JSON (same format) to: ${p.resultPath}`);
  return true;
}
