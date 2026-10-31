// pi-relay: The advisor: plain-language decision briefs, decisions by the owner or the advisory council, records and replies.

import fs from 'node:fs';
import { agentAlive, closeAgent, ensureAgent } from './agents.mjs';
import { C, callout, emit, event, log, roleTag } from './console.mjs';
import { advisorOwnerReasons, classTable, councilAttribution, councilBriefProblem, councilEnabled, ownerNotes, runCouncil } from './council.mjs';
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
    return `Option ${bad + 1} postpones the decision but does not state its "deferral" (${Object.keys(DEFERRAL_FIELDS).join(', ')}). `
      + 'Give all four, or, if you cannot, replace it with a concrete answer: do not offer it as a postponement.';
  }
  return councilEnabled() ? councilBriefProblem(b) : null;
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

export function recordDecision(slice, final, attribution) {
  const header = `# Decisions: ${ctx.topic}\n\nRecorded by pi-relay: the owner's answers and, where enabled, the advisory council's decisions. Every worker reads this file.\n`;
  const text = fs.existsSync(ctx.decisions) ? fs.readFileSync(ctx.decisions, 'utf8') : header;
  const id = `D${(text.match(/^## D\d+/gm) ?? []).length + 1}`;
  const title = String(final.title ?? 'Decision').replace(/\s+/g, ' ').trim();
  const deferral = final.deferral
    ? `\n**Deferred.**\n${Object.entries(DEFERRAL_FIELDS).map(([k, name]) => `- ${name}: ${String(final.deferral[k]).trim()}`).join('\n')}\n` : '';
  fs.writeFileSync(ctx.decisions, `${text.trimEnd()}\n\n## ${id} \u00b7 ${new Date().toISOString().slice(0, 10)} \u00b7 ${slice.id} \u00b7 ${title}\n\n${final.decision.trim()}\n${deferral}\n${attribution}\n`);
  return { id, title };
}

// The advice for one question moves through saved stages (state.cur.advice), so a relay restart resumes
// it without asking or recording twice: brief → (council) → decision → recorded → delivered.
// Returns true when the waiting worker has received the decision, 'set-aside' when a prerequisite slice
// runs first, and false to fall back to asking the owner directly in the worker's tab.
export function consultAdvisor(worker, p, r) {
  const c = state.cur;
  const slice = currentSlice();
  const fallback = (why, what = 'could not prepare a brief') => {
    log(`${slice.id} advisor unavailable (${why}); asking the owner directly`, { quiet: true });
    event(C.yellow('\u26a0'), `${roleTag('advisor')} ${C.yellow(what)} ${C.dim(`\u00b7 ${why}; asking you directly`)}`);
    closeAgent('advisor');
    for (const role of Object.keys(c.advice?.council?.members ?? {})) closeAgent(role);
    c.advice = null;
    save();
    return false;
  };
  let a = c.advice?.workerMtime === r._mtime ? c.advice : null; // resume an advice already under way for this question
  if (!a) {
    closeAgent('advisor');
    a = c.advice = { workerRole: worker.role, workerMtime: r._mtime, workerResult: r._path, briefPath: resultPathFor('advisor', 'brief'), startedAt: Date.now(), sent: 0 };
    c.assignments.advisor = writeAssignment('advisor', 'advise', slice,
      `The ${worker.role} is waiting for the owner. Its result, with its question, is ${r._path}; its record is `
      + `${artifactPath(worker.role, slice.id)}${fs.existsSync(artifactPath(worker.role, slice.id)) ? '' : ' (not written yet; that is normal when it asks early)'}. `
      + `Decisions so far: ${ctx.decisions}${fs.existsSync(ctx.decisions) ? '' : ' (none yet)'}; check it for earlier deferrals of the same question. `
      + 'Where the project\'s own instructions (its AGENTS.md or equivalent, and the decision records they point to) define rules for '
      + 'decisions and deferrals, follow them: they take precedence over the defaults of your prompt. Write the brief, wait for the '
      + 'owner to answer in this session, then write the decision and the replies (the waiting worker is the '
      + `${worker.role}). `
      + (sliceChanged()
        ? 'This slice already has commits or changes since it started, so a prerequisite slice cannot be inserted before it: do not offer that option.'
        : 'This slice has no commits or changes yet, so a prerequisite slice can be inserted before it if the owner chooses one.')
      + (councilEnabled()
        ? `\n\nThe advisory council is enabled. Give every option in your brief an "action" (what workers will do, exact and technical) and its "classes", and set "ownerNeeded" (null, or why the owner must decide). The relay then either shows your brief to the owner, or has two council members vote on it and asks you to write their decision. Classes:\n\n${classTable()}`
        : ''));
    save();
    emit('advisor_start', { workerRole: worker.role, question: r.question ?? null });
    event(C.magenta('?'), `${roleTag(worker.role)} ${C.magenta('needs a decision')} ${C.dim('\u00b7 asking the advisor for a plain-language brief')}`,
      r.question ?? r.summary ?? '');
  }
  if (!a.recorded) {
    quotaGate('advisor');
    const { agent } = ensureAgent('advisor');
    const ask = (text) => { a.sent = Date.now(); save(); settle(agent, prompt(agent, text)); };
    if (!a.brief) {
      let brief = readResult(a.briefPath, a.startedAt);
      if (!brief && !a.sent) {
        ask(`/advise Read and execute the relay assignment at ${c.assignments.advisor}\n\nResult file for this step: ${a.briefPath}`);
      } else if (!brief && agentAlive(agent)?.agent_status === 'working') settle(agent, 'working');
      brief = brief ?? readResult(a.briefPath, a.startedAt);
      const problem = briefProblem(brief);
      if (problem) {
        ask(`${problem} Write it to ${a.briefPath} (status "needs-decision") as valid JSON, as your assignment describes, then wait for the owner.`);
        brief = readResult(a.briefPath, a.sent) ?? brief;
      }
      if (!brief) return fallback('no brief written');
      if (brief.status !== 'needs-decision') return fallback(`unexpected advisor result "${brief.status}"`);
      if (briefProblem(brief)) return fallback('incomplete brief');
      a.brief = brief;
      save();
      emit('advisor_brief', { title: brief.brief.title ?? null, options: brief.brief.options.length, recommended: brief.brief.recommended ?? null });
    }
    const got = decide(agent, a, slice, ask);
    if (got.fail) return fallback(...got.fail);
    a.final = got.final;
    a.by = got.by;
    a.recorded = recordDecision(slice, got.final, got.attribution);
    save();
    const { id, title } = a.recorded;
    emit(got.by === 'council' ? 'council_decision' : 'owner_decision', { id, title, decision: got.final.decision, workerRole: worker.role, replies: Object.keys(got.final.replies ?? {}), slice: got.final.slice?.title ?? null });
    log(`${slice.id} ${got.by} decision ${id}: ${title}`, { quiet: true });
    event(C.green('\u2713'), `${C.green(C.bold(`${got.by === 'council' ? 'council ' : ''}decision ${id}`))} ${title}`, got.final.decision);
    if (got.by === 'council') {
      state.councilDecisions = [...(state.councilDecisions ?? []), { id, title, slice: slice.id }];
      save();
      notify(`Relay ${ctx.topic}: council decided ${id}`, `${title}\nRecorded in decisions.md; a later decision of yours can overrule it.`);
    }
    closeAgent('advisor');
  }
  return deliver(worker, p, a, slice);
}

// The decision for the brief: the council's when it agrees on a delegated option, else the owner's.
// Returns { final, by, attribution } or { fail: [why, what] }.
function decide(agent, a, slice, ask) {
  let notes = [];
  let why = [];
  if (councilEnabled()) {
    const direct = advisorOwnerReasons(a.brief);
    const outcome = direct.length ? { owner: direct } : runCouncil(a, slice);
    if (outcome.decided !== undefined) {
      const final = councilFinal(agent, a, outcome, ask);
      if (final.problem) return { fail: [final.problem, 'could not write the council\'s decision'] };
      return { final, by: 'council', attribution: councilAttribution(a) };
    }
    why = outcome.owner;
    notes = a.council ? ownerNotes(a) : [`The advisory council was not consulted: ${why.join('; ')}.`];
  }
  const shown = { ...a.brief, brief: { ...a.brief.brief, notes: [...(a.brief.brief.notes ?? []), ...notes] } };
  let final = waitForOperator(agent, shown, { show: showBrief, track: false });
  if (final.status === 'invalid' || (final.status === 'done' && !valid('advisor', final))) {
    // A malformed decision file: the owner has answered, so ask once for a corrected file.
    ask(`Your result file ${a.briefPath} is invalid (${final.summary ?? 'no decision, or an incomplete slice'}). Rewrite it as valid JSON `
      + 'with status "done", the decision, its title, the replies, if the owner chose one, the slice with a one-line title and '
      + 'at least one acceptance condition, and, if the owner chose to postpone, the deferral with all four fields, as your assignment '
      + 'describes. Do not ask the owner again.');
    final = readResult(a.briefPath, a.sent) ?? final;
  }
  // Never let the advisor decide without the owner: a decision must follow a brief the owner saw.
  if (!valid('advisor', final) || final.status !== 'done') return { fail: [`unexpected advisor result "${final?.status}"`, 'could not record your decision'] };
  return { final, by: 'owner', attribution: `**Decided by the owner.**${why.length ? ` It came to the owner because ${why.join('; ')}.` : ''}` };
}

// The advisor writes the council's decision to its own file; it must match the chosen option.
function councilFinal(agent, a, outcome, ask) {
  const o = a.brief.brief.options[outcome.decided];
  a.finalPath ??= resultPathFor('advisor', 'decision');
  save();
  const problem = (f) => {
    if (!f) return 'no decision written';
    if (f.status === 'blocked') return `the advisor could not write it: ${f.summary ?? f.question ?? ''}`;
    if (f.status !== 'done' || !valid('advisor', f)) return `invalid decision (${f.summary ?? f.status})`;
    if (Boolean(o.deferral) !== Boolean(f.deferral)) return o.deferral ? 'the chosen option postpones, but the decision has no deferral' : 'the decision adds a deferral the chosen option does not have';
    if (Boolean(o.slice) !== Boolean(f.slice)) return o.slice ? 'the chosen option inserts a prerequisite slice, but the decision has none' : 'the decision adds a prerequisite slice the chosen option does not have';
    return null;
  };
  let final = readResult(a.finalPath, a.startedAt);
  if (!final) {
    const conditions = outcome.conditions.length ? `Conditions the members added (keep them; they limit the action):\n${outcome.conditions.map((x) => `- ${x}`).join('\n')}\n\n` : '';
    ask(`The advisory council decided this question; the owner is not asked. Both members chose option ${outcome.decided + 1}, "${o.label}" `
      + `(their votes: ${Object.values(a.council.members).map((m) => m.votePath).join(', ')}).\n\nAction: ${o.action}\n\n${conditions}`
      + 'Write the decision as your assignment describes for after the owner chose: the decision (this option\'s action and the conditions, exact and technical, self-contained, saying the advisory council decided it), its title, the replies'
      + `${o.deferral ? ', the deferral of this option with all four fields' : ''}${o.slice ? ', and the prerequisite slice of this option' : ''}. Do not add scope or change the action. `
      + 'If the conditions contradict each other or the action, write status "blocked" with the contradiction instead.'
      + `\n\nResult file (status "done"): ${a.finalPath}`);
    final = readResult(a.finalPath, a.sent);
  }
  const first = problem(final);
  if (first && final?.status !== 'blocked') {
    ask(`Your decision file ${a.finalPath} is not acceptable: ${first}. Rewrite it for the council's choice, option ${outcome.decided + 1}, as described above.`);
    final = readResult(a.finalPath, a.sent) ?? final;
  }
  const last = problem(final);
  return last ? { problem: last } : final;
}

function deliver(worker, p, a, slice) {
  const c = state.cur;
  const { final } = a;
  const { id } = a.recorded;
  const label = `${a.by === 'council' ? 'Council' : 'Owner'} decision ${id}`;
  if (final.slice) {
    if (sliceChanged()) {
      c.advice = null;
      save();
      throw new RelayStop(`${label} asks for a prerequisite slice ("${final.slice.title}") before ${slice.id}, but ${slice.id} `
        + `already has commits or changes, so the relay cannot set it aside. Add the slice to plan.md where it fits and deal with `
        + `${slice.id}'s changes, then re-run pi-relay ${ctx.topic}. The ${worker.role} is still waiting in its tab.`);
    }
    a.inserted ??= insertPrerequisite(slice, final.slice, `${a.by} decision ${id}`);
    save();
    setAside(a.inserted, { role: worker.role, purpose: p.purpose, text: `${label} (recorded in ${ctx.decisions}): ${final.replies?.[worker.role] ?? final.decision}` });
    return 'set-aside';
  }
  for (const [role, text] of Object.entries(a.notesAdded ? {} : final.replies ?? {})) {
    if (role === worker.role || !text) continue;
    c.notes = c.notes ?? {};
    c.notes[role] = [c.notes[role], `${label} (${ctx.decisions}): ${text}`].filter(Boolean).join('\n\n');
  }
  a.notesAdded = true;
  const reply = final.replies?.[worker.role] ?? final.decision;
  p.sentAt = Date.now();
  save();
  event(C.cyan('\u2192'), `${roleTag(worker.role)} ${C.dim(`decision ${id} delivered`)}`);
  prompt(worker, `${label} (recorded in ${ctx.decisions}):\n\n${reply}\n\nContinue your current step. `
    + `Write this step's result JSON (same format) to: ${p.resultPath}`);
  c.advice = null; // only now: a restart before this point delivers the recorded decision again
  save();
  return true;
}
