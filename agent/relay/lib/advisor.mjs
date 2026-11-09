// pi-relay: The advisor: plain-language decision briefs, decisions by the owner or the advisory council, records and replies.

import fs from 'node:fs';
import { agentAlive, closeAgent, closeTabs, ensureAgent, releaseAgent, releaseAll } from './agents.mjs';
import { sliceChanged } from './changes.mjs';
import { C, callout, emit, event, log, roleTag } from './console.mjs';
import { advisorOwnerReasons, classTable, councilAttribution, councilBriefProblem, councilDecision, councilEnabled, ownerNotes, runCouncil } from './council.mjs';
import { insertPrerequisite, prerequisiteId, setAside } from './prerequisites.mjs';
import { quotaGate } from './quota.mjs';
import { cfg, ctx, notify, RelayStop, state } from './runtime.mjs';
import { artifactPath, DEFERRAL_FIELDS, readResult, resultPathFor, valid, validDeferral, writeAssignment } from './steps.mjs';
import { save, writeFileAtomic } from './store.mjs';
import { currentSlice } from './transitions.mjs';
import { promptOnce, resumePrompt, settle, showQuestion, waitForOperator } from './waiting.mjs';

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

// The next decision id, reserved (and saved with the decision) before decisions.md is written.
export function nextDecisionId() {
  const text = fs.existsSync(ctx.decisions) ? fs.readFileSync(ctx.decisions, 'utf8') : '';
  return `D${(text.match(/^## D\d+ /gm) ?? []).length + 1}`;
}

// Appends decision `id` to decisions.md unless it is there already (a replay after a kill), atomically.
export function recordDecision(slice, final, attribution, id) {
  const header = `# Decisions: ${ctx.topic}\n\nRecorded by pi-relay: the owner's answers and, where enabled, the advisory council's decisions. Every worker reads this file.\n`;
  const text = fs.existsSync(ctx.decisions) ? fs.readFileSync(ctx.decisions, 'utf8') : header;
  const title = String(final.title ?? 'Decision').replace(/\s+/g, ' ').trim();
  if (new RegExp(`^## ${id} \u00b7 `, 'm').test(text)) return { title, written: false };
  const deferral = final.deferral
    ? `\n**Deferred.**\n${Object.entries(DEFERRAL_FIELDS).map(([k, name]) => `- ${name}: ${String(final.deferral[k]).trim()}`).join('\n')}\n` : '';
  writeFileAtomic(ctx.decisions, `${text.trimEnd()}\n\n## ${id} \u00b7 ${new Date().toISOString().slice(0, 10)} \u00b7 ${slice.id} \u00b7 ${title}\n\n${final.decision.trim()}\n${deferral}\n${attribution}\n`);
  return { title, written: true };
}

// Whether a prerequisite slice can be added now, for the advisor's assignment and for deliver().
function prerequisiteBlocked(slice) {
  if (slice.id === 'PLAN') return 'no plan exists yet to insert it into';
  if (sliceChanged()) return `${slice.id} already has commits or changes since it started, so it cannot be set aside`;
  return null;
}

// The advice for one question moves through saved stages (state.cur.advice), so a relay restart resumes
// it without asking or recording twice: brief → (council) → decision reserved (id and content) → recorded →
// delivered. Returns true when the waiting worker has received the decision, 'set-aside' when a prerequisite
// slice runs first, and false to fall back to asking the owner directly in the worker's tab.
export function consultAdvisor(worker, p, r) {
  const c = state.cur;
  const slice = currentSlice();
  const fallback = (why, what = 'could not prepare a brief') => {
    log(`${slice.id} advisor unavailable (${why}); asking the owner directly`, { quiet: true });
    event(C.yellow('\u26a0'), `${roleTag('advisor')} ${C.yellow(what)} ${C.dim(`\u00b7 ${why}; asking you directly`)}`);
    releaseAgent('advisor');
    for (const role of Object.keys(c.advice?.council?.members ?? {})) releaseAgent(role);
    c.advice = null;
    save();
    closeTabs();
    return false;
  };
  let a = c.advice?.workerMtime === r._mtime ? c.advice : null; // resume an advice already under way for this question
  if (!a) {
    releaseAgent('advisor');
    const blocked = prerequisiteBlocked(slice);
    const assignment = writeAssignment('advisor', 'advise', slice,
      `The ${worker.role} is waiting for the owner. Its result, with its question, is ${r._path}; its record is `
      + `${artifactPath(worker.role, slice.id)}${fs.existsSync(artifactPath(worker.role, slice.id)) ? '' : ' (not written yet; that is normal when it asks early)'}. `
      + `Decisions so far: ${ctx.decisions}${fs.existsSync(ctx.decisions) ? '' : ' (none yet)'}; check it for earlier deferrals of the same question. `
      + 'Where the project\'s own instructions (its AGENTS.md or equivalent, and the decision records they point to) define rules for '
      + 'decisions and deferrals, follow them: they take precedence over the defaults of your prompt. Write the brief, wait for the '
      + 'owner to answer in this session, then write the decision and the replies (the waiting worker is the '
      + `${worker.role}). `
      + (blocked ? `A prerequisite slice cannot be added now: ${blocked}. Do not offer that option.`
        : slice.id === 'FINAL' ? 'The final verification has changed nothing yet, so a prerequisite slice can be added after the plan\'s last slice if the owner chooses one; the final verification then starts again after it.'
          : 'This slice has no commits or changes yet, so a prerequisite slice can be inserted before it if the owner chooses one.')
      + (councilEnabled()
        ? `\n\nThe advisory council is enabled. Give every option in your brief an "action" (what workers will do, exact and technical) and its "classes", and set "ownerNeeded" (null, or why the owner must decide). The relay then either shows your brief to the owner, or has two council members vote on it: when they agree, the relay records the chosen option's action word for word, with the members' conditions, as the binding decision and sends it to the worker, so write every action self-contained (no "as in option 2"). You do not write a council decision. Classes:\n\n${classTable()}`
        : ''));
    a = c.advice = { workerRole: worker.role, workerMtime: r._mtime, workerResult: r._path, briefPath: resultPathFor('advisor', 'brief'), startedAt: Date.now(), sent: 0 };
    c.assignments.advisor = assignment;
    save();
    closeTabs();
    emit('advisor_start', { workerRole: worker.role, question: r.question ?? null });
    event(C.magenta('?'), `${roleTag(worker.role)} ${C.magenta('needs a decision')} ${C.dim('\u00b7 asking the advisor for a plain-language brief')}`,
      r.question ?? r.summary ?? '');
  }
  if (!a.recorded) {
    if (!a.recording) {
      quotaGate('advisor');
      const { agent } = ensureAgent('advisor');
      const resumed = resumePrompt(agent, a, 'prompting'); // a prompt a killed relay may not have delivered
      if (resumed) settle(agent, resumed);
      const ask = (text, expect = a.briefPath) => { a.sent = Date.now(); settle(agent, promptOnce(agent, a, 'prompting', text, expect)); };
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
      const got = decide(agent, a, slice, ask, p);
      if (got.fail) return fallback(...got.fail);
      a.recording = { id: nextDecisionId(), final: got.final, by: got.by, attribution: got.attribution };
      save();
    }
    const { id, final, by, attribution } = a.recording;
    const { title, written } = recordDecision(slice, final, attribution, id);
    a.final = final;
    a.by = by;
    a.recorded = { id, title };
    if (by === 'council') state.councilDecisions = [...(state.councilDecisions ?? []).filter((d) => d.id !== id), { id, title, slice: slice.id }];
    save();
    if (written) { // not again on a replay
      emit(by === 'council' ? 'council_decision' : 'owner_decision', { id, title, decision: final.decision, workerRole: worker.role, replies: Object.keys(final.replies ?? {}), slice: final.slice?.title ?? null });
      log(`${slice.id} ${by} decision ${id}: ${title}`, { quiet: true });
      event(C.green('\u2713'), `${C.green(C.bold(`${by === 'council' ? 'council ' : ''}decision ${id}`))} ${title}`, final.decision);
      if (by === 'council') notify(`Relay ${ctx.topic}: council decided ${id}`, `${title}\nRecorded in decisions.md; a later decision of yours can overrule it.`);
    }
    closeAgent('advisor');
  }
  return deliver(worker, p, a, slice);
}

// The decision for the brief: the council's when it agrees on a delegated option (built by the relay from
// the vote), else the owner's. A worker that could not follow a council decision in this step asks the owner:
// the council is not asked again. Returns { final, by, attribution } or { fail: [why, what] }.
function decide(agent, a, slice, ask, p) {
  let notes = [];
  let why = [];
  if (councilEnabled()) {
    const asked = state.cur.councilAsked?.[stepKey(p)];
    const direct = [...advisorOwnerReasons(a.brief), ...(asked ? [`the ${a.workerRole} asked again after council decision ${asked}`] : [])];
    const outcome = direct.length ? { owner: direct } : runCouncil(a, slice);
    if (outcome.decided !== undefined) return { final: councilDecision(a, outcome), by: 'council', attribution: councilAttribution(a) };
    why = outcome.owner;
    notes = a.council ? ownerNotes(a) : [`The advisory council was not consulted: ${why.join('; ')}.`];
  }
  const shown = { ...a.brief, brief: { ...a.brief.brief, notes: [...(a.brief.brief.notes ?? []), ...notes] } };
  // After a restart the owner may already have answered: use that answer instead of showing the brief again.
  const answered = readResult(a.briefPath, a.brief._mtime + 1);
  let final = answered && answered._mtime > a.brief._mtime && answered.status !== 'needs-decision'
    ? answered : waitForOperator(agent, shown, { show: showBrief, track: false });
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

function deliver(worker, p, a, slice) {
  const c = state.cur;
  const { final } = a;
  const { id } = a.recorded;
  const label = `${a.by === 'council' ? 'Council' : 'Owner'} decision ${id}`;
  // Notes for the other roles first: a set-aside slice keeps them for when it resumes.
  for (const [role, text] of Object.entries(a.notesAdded ? {} : final.replies ?? {})) {
    if (role === worker.role || !text) continue;
    c.notes = c.notes ?? {};
    c.notes[role] = [c.notes[role], `${label} (${ctx.decisions}): ${text}`].filter(Boolean).join('\n\n');
  }
  a.notesAdded = true;
  // A council decision marks the step it answered in the slice's state: a later question from that step goes to
  // the owner (decide()). Whatever rebuilds the step (resume, retry, the senior, --fresh) keeps its key.
  if (a.by === 'council') c.councilAsked = { ...c.councilAsked, [stepKey(p)]: id };
  if (final.slice) {
    const blocked = prerequisiteBlocked(slice);
    if (blocked) {
      c.advice = null;
      save();
      throw new RelayStop(`${label} asks for a prerequisite slice ("${final.slice.title}"), but ${blocked}. `
        + (slice.id === 'PLAN'
          ? `Answer the planner in its tab before re-running pi-relay ${ctx.topic}, or add the slice to the plan it writes.`
          : `Add the slice to plan.md where it fits and deal with ${slice.id}'s changes, then re-run pi-relay ${ctx.topic}.`)
        + ` The ${worker.role} is still waiting in its tab.`);
    }
    // The slice id is reserved and saved first, so a replay after a kill writes the same slice once.
    if (!a.inserting) { a.inserting = prerequisiteId(slice, final.slice, `${a.by} decision ${id}`); save(); }
    a.inserted ??= insertPrerequisite(slice, final.slice, `${a.by} decision ${id}`, a.inserting);
    if (slice.id === 'FINAL') return restartFinalAfter(a.inserted);
    save();
    setAside(a.inserted, { role: worker.role, purpose: p.purpose, text: `${label} (recorded in ${ctx.decisions}): ${final.replies?.[worker.role] ?? final.decision}` });
    return 'set-aside';
  }
  const reply = final.replies?.[worker.role] ?? final.decision;
  // The worker's question stays readable until the decision has reached it (p.sentAt moves only below), so a
  // restart in between finds the question, resumes this advice and finishes the delivery attempt.
  const at = a.delivering?.at ?? Date.now();
  if (!resumePrompt(worker, a, 'delivering')) {
    event(C.cyan('\u2192'), `${roleTag(worker.role)} ${C.dim(`decision ${id} delivered`)}`);
    promptOnce(worker, a, 'delivering', `${label} (recorded in ${ctx.decisions}):\n\n${reply}\n\nContinue your current step. `
      + `Write this step's result JSON (same format) to: ${p.resultPath}`, p.resultPath);
  }
  p.sentAt = at;
  p.answered = a.workerMtime; // that version of the result file is the question just answered, never a new one
  c.advice = null; // only now: a restart before this point delivers the recorded decision again
  save();
  return true;
}

// One step of a slice, the same across whatever rebuilds it: its role (the senior continues the implementer's
// step) and purpose (help steps by their number: several can share a role).
function stepKey(p) {
  const role = p.role === 'senior' ? 'implementer' : p.role;
  return `${role}:${p.purpose === 'help' ? `help${state.cur.help}` : p.purpose}`;
}

// A prerequisite slice chosen during a final verification that changed nothing: the slice was appended to the
// plan; FINAL is dropped (not recorded done), so it starts again after the slice.
function restartFinalAfter(id) {
  releaseAll();
  state.cur = null;
  emit('slice_set_aside', { slice: 'FINAL', before: id, restart: true });
  log(`FINAL set aside: ${id} runs first; then the final verification starts again`, { quiet: true });
  event(C.yellow('\u21b7'), `${C.yellow('final verification set aside')} ${C.dim(`\u00b7 ${id} runs first; then it starts again`)}`);
  save();
  closeTabs();
  return 'set-aside';
}
