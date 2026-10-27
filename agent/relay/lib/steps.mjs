// pi-relay: Assignments, prompts, result files and waiting: one step of one worker.

import fs from 'node:fs';
import path from 'node:path';
import { advisorEnabled, consultAdvisor } from './advisor.mjs';
import { agentAlive, ensureAgent } from './agents.mjs';
import { C, callout, clearLive, compactionText, emit, event, fmtDuration, hhmm, live, log, purposeLabel, roleTag } from './console.mjs';
import { run } from './io.mjs';
import { quotaGate } from './quota.mjs';
import { cfg, ctx, herdr, HUMAN_STATUSES, notify, plural, RelayStop, sleep, state, STATUSES, TEMPLATE } from './runtime.mjs';
import { save } from './store.mjs';
import { currentSlice } from './transitions.mjs';
import { sessionTotals, stepUsage } from './usage.mjs';

export function sliceDir(id) {
  const dir = path.join(ctx.topicDir, 'slices', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function artifactPath(role, sliceId) {
  if (role === 'planner') return ctx.plan;
  const file = { scout: 'scout.md', architect: 'architecture.md', implementer: 'implementation.md', senior: 'implementation.md', reviewer: 'review.md', advisor: 'advice.md' }[role];
  return path.join(sliceDir(sliceId), file);
}

export function gitRules(role) {
  if (role !== 'implementer' && role !== 'senior') {
    return 'Do not edit product files (code, tests, configuration, docs). Write only your artifact and the result file. No Git writes.';
  }
  return cfg.commit
    ? 'Git: when your focused checks pass, commit your work for this slice. Stage explicit paths only (never `git add -A`, `git add .` or `commit -a`); '
      + 'never stage the pre-existing changes listed above or `.agents_work/`. Use the repository\'s commit-message convention. '
      + 'Repairs are new commits: never amend, rebase, reset, force or push.'
    : 'Git: do not stage, commit, switch branches or push. Leave your changes in the working tree.';
}

export function writeAssignment(role, purpose, slice, task) {
  const id = `${String(++state.seq).padStart(3, '0')}-${role}`;
  const file = path.join(ctx.relayDir, `${id}.md`);
  const statuses = STATUSES[role].map((s) => `\`${s}\``).join(', ');
  const others = ['scout', 'architect', 'implementer', 'reviewer']
    .filter((r) => r !== role && slice.id !== 'PLAN')
    .map((r) => artifactPath(r, slice.id))
    .filter((p) => fs.existsSync(p) && p !== artifactPath(role, slice.id));
  const reviewerFields = role === 'reviewer'
    ? '\n  "verdict": "accept | changes-required",   // required when status is done\n  "blocking": ["R1"],                       // IDs of findings that must be fixed; empty when accepting'
    : '';
  const questionFields = role === 'advisor' ? '' : '\n  "options": [{ "label": "...", "consequence": "..." }],  // with needs-decision: 2-4 real options'
    + '\n             // an option may propose a prerequisite slice: add "slice": { "title": "...", "acceptance": ["..."], "notes": "..." }'
    + '\n  "recommended": 1, "reason": "why you recommend it",   // with needs-decision';
  const advisorFields = role !== 'advisor' ? '' : `
  // status needs-decision (the brief for the owner):
  "brief": { "title": "...", "question": "...", "context": "...",
             "options": [{ "label": "...", "consequence": "..." }], "recommended": 1, "reason": "...", "notes": [] },
  // status done (after the owner chose):
  "title": "short decision title", "decision": "the decision as it should be recorded",
  "replies": { "<role>": "instruction or note for that role" },
  "slice": { "title": "...", "acceptance": ["..."], "notes": "..." },  // only when the owner chose a prerequisite slice`;
  const body = `# Relay assignment ${id}: ${role} for ${slice.id} — ${slice.title}

You are one worker in an automated relay run by a script, not by a person. Nobody reads your
chat; the script reads only the result file named in each message. Do your role's job, write
the result file, then stop. Do not launch other agents and do not start another role's work.

- Project checkout: ${ctx.project}
- Topic folder: ${ctx.topicDir}
- Handoff (agreed intent, scope, acceptance, authority): ${fs.existsSync(ctx.handoff) ? ctx.handoff : '(none)'}
- Plan: ${fs.existsSync(ctx.plan) ? ctx.plan : '(not written yet)'}
- Slice base commit: ${state.cur.base ?? '(none)'}
- Owner decisions so far: ${ctx.decisions}${fs.existsSync(ctx.decisions) ? '' : ' (none yet)'}. Read it before you start;
  never ask the owner again about something it already settles.
- Your artifact: ${artifactPath(role, slice.id)}
${others.length ? `- Other artifacts for this slice: ${others.join(', ')}\n` : ''}
Pre-existing uncommitted changes when the relay started (not this work; never stage, revert or edit them):
\`\`\`
${state.startStatus || '(none)'}
\`\`\`

## Slice
${slice.body || slice.title}

## Task
${task}

## Rules
- ${gitRules(role)}
- Do not change ticket/tracker status. Put proposed tracker updates in your artifact.
- Stay within the handoff's scope and the slice's acceptance. Optional improvements go in your
  artifact as suggestions; they are not work for this run.
- Ask only when you genuinely cannot proceed (a product/scope decision, a missing permission or an
  external blocker), or when a materially better approach needs authority you lack. Use \`needs-decision\` / \`blocked\` with one precise question. Never put a question for
  the owner only in your artifact while reporting \`done\`. For \`needs-decision\`, also give the options
  and your recommendation (fields below), written in plain words for an owner who does not know the
  code. The answer comes back to you in this session; then continue and overwrite the same result file.

## Result file (required at every stop)
Each message names a result path. Before you stop, write JSON there:
\`\`\`
{
  "status": "<one of: ${STATUSES[role].join(' | ')}>",
  "summary": "two or three plain sentences: what you did and the outcome",
  "question": "the one precise question, only for needs-* or blocked",${reviewerFields}${questionFields}${advisorFields}
  "checks": ["command → pass/fail", "..."],
  "artifact": "${artifactPath(role, slice.id)}"
}
\`\`\`
Allowed statuses for your role: ${statuses}.
`;
  fs.writeFileSync(file, body);
  save();
  return file;
}

export function resultPathFor(role, purpose) {
  return path.join(ctx.relayDir, `${String(++state.seq).padStart(3, '0')}-${role}-${purpose}.result.json`);
}

// A message is { role, purpose, text, initial } where `initial` messages create a new assignment.
export function queue(msg) { state.cur.queued = msg; save(); }

// ---------- delivery and waiting ----------

export function readResult(file, since) {
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  if (st.mtimeMs < since - 2000) return null;
  try {
    return { ...JSON.parse(fs.readFileSync(file, 'utf8')), _path: file, _mtime: st.mtimeMs };
  } catch (e) {
    return { status: 'invalid', summary: `Unparseable result JSON: ${e.message}`, _path: file, _mtime: st.mtimeMs };
  }
}

export function valid(role, r) {
  if (!r || !STATUSES[role].includes(r.status)) return false;
  if (role === 'reviewer' && r.status === 'done') return ['accept', 'changes-required'].includes(r.verdict);
  if (role === 'advisor' && r.status === 'done') {
    return typeof r.decision === 'string' && r.decision.trim() !== '' && (r.slice === undefined || r.slice === null || validSliceSpec(r.slice));
  }
  return true;
}

// A prerequisite slice chosen by the owner: one-line title and at least one acceptance condition.
export function validSliceSpec(s) {
  const line = (x) => typeof x === 'string' && x.trim() !== '' && !x.includes('\n');
  return Boolean(s) && line(s.title) && Array.isArray(s.acceptance) && s.acceptance.length > 0 && s.acceptance.every(line)
    && (s.notes === undefined || typeof s.notes === 'string');
}

// Wait until the agent settles, handling permission prompts by waiting for the operator.
export function settle(agent, status) {
  const settleStart = Date.now();
  for (;;) {
    if (status === 'blocked') {
      sleep(4000); // Herdr can report "blocked" for a moment while a tool starts
      const again = herdr(['agent', 'get', agent.name], { allowFail: true });
      if (!again.error && again.agent.agent_status !== 'blocked') { status = again.agent.agent_status; continue; }
      log(`${state.cur.slice} ${agent.role} is waiting on a prompt in tab "${agent.label}"`, { quiet: true });
      callout(C.magenta, `${agent.role} is waiting on a prompt`, [`Answer it in tab "${agent.label}". The relay continues by itself.`]);
      notify(`Relay ${ctx.topic}: ${agent.role} needs you`, `Answer the prompt in tab "${agent.label}".`);
      const blockStart = Date.now();
      herdr(['agent', 'wait', agent.name, '--until', 'working', '--until', 'idle', '--until', 'done']);
      emit('permission_wait', { role: agent.role, waitedMs: Date.now() - blockStart });
    }
    // Short waits so the console can show a live "working for 12m" line in between.
    const r = herdr(['agent', 'wait', agent.name, '--timeout', '10000'], { allowFail: true });
    if (r.error?.code === 'timeout') {
      // Step usage and the compaction limit belong to the pending step's worker, not to a helper
      // such as the advisor that may be working while that step waits.
      const pending = state.cur?.pending;
      const p = pending && pending.role === agent.role ? pending : null;
      const u = p ? stepUsage(p) : null;
      const limit = cfg.maxCompactionsPerStep ?? 3;
      if (u && limit > 0 && u.compactions >= limit && !p.runaway) {
        interruptRunaway(agent, p, u);
        status = 'working';
        continue;
      }
      const facts = [fmtDuration(Date.now() - (p?.firstSentAt ?? p?.sentAt ?? settleStart))];
      if (u) facts.push(plural(u.turns, 'turn'));
      live(`  ${C.gray(hhmm())}  ${C.cyan('\u25f7')} ${roleTag(agent.role)} ${C.dim(`working \u00b7 ${facts.join(' \u00b7 ')}`)}`
        + (u ? `${C.dim(' \u00b7 ')}${compactionText(u.compactions)}` : ''));
      status = 'working';
      continue;
    }
    if (r.error) throw new RelayStop(`Lost ${agent.role} agent ${agent.name}: ${r.error.message}`);
    status = r.agent.agent_status;
    if (status === 'idle' || status === 'done') { clearLive(); return; }
    if (status === 'unknown') sleep(5000);
  }
}

// A worker that compacts too often in one step has outgrown its context or is going in circles.
// Interrupt it (Escape, as in its tab), mark the step, and let collect()/transition() decide.
export function markRunaway(agent, p, u, interrupted) {
  p.runaway = { compactions: u.compactions, turns: u.turns };
  save();
  clearLive();
  const what = `${interrupted ? 'interrupted' : 'stopped'} after ${plural(u.compactions, 'compaction')} in one step`;
  event(C.red('\u25a0'), `${roleTag(agent.role)} ${C.red(what)} ${C.gray(`\u00b7 ${plural(u.turns, 'turn')}`)}`);
  log(`${state.cur.slice} ${agent.role} ${what} (${u.turns} turns)`, { quiet: true });
  emit('runaway', { role: agent.role, purpose: p.purpose, compactions: u.compactions, turns: u.turns, interrupted });
}

export function interruptRunaway(agent, p, u) {
  markRunaway(agent, p, u, true);
  for (let i = 0; i < 6; i++) {
    herdr(['agent', 'send-keys', agent.name, 'Escape'], { allowFail: true });
    const r = herdr(['agent', 'wait', agent.name, '--until', 'idle', '--until', 'done', '--timeout', '20000'], { allowFail: true });
    if (!r.error) return;
  }
}

// Submit and return once the agent has picked the prompt up; settle() does the long wait.
export function prompt(agent, text) {
  for (;;) {
    const r = herdr(['agent', 'prompt', agent.name, text, '--wait', '--until', 'working', '--until', 'blocked'], { allowFail: true });
    if (!r.error) return r.agent.agent_status;
    if (r.error.code === 'agent_blocked') { settle(agent, 'blocked'); continue; }
    if (r.error.code === 'agent_prompt_stalled') {
      const status = submitPendingInput(agent);
      if (status) return status;
      throw new RelayStop(`The ${agent.role} did not start after its prompt was typed (tab "${agent.label}"). `
        + `Check that tab: if the prompt is still in its input box, press Enter there, then re-run pi-relay ${ctx.topic}.`);
    }
    throw new Error(`Prompt to ${agent.role} failed: ${r.error.code}: ${r.error.message}`);
  }
}

// The prompt text can end up typed but unsent in the worker's input box, e.g. when the Enter key is
// taken by the slash-command menu. Press Enter again (harmless on an empty box) and check that the
// worker started. Returns its status, or null if it still has not started.
export function submitPendingInput(agent) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    herdr(['agent', 'send-keys', agent.name, 'Enter'], { allowFail: true });
    const r = herdr(['agent', 'wait', agent.name, '--until', 'working', '--until', 'blocked', '--timeout', '8000'], { allowFail: true });
    if (!r.error) {
      log(`${state.cur?.slice} ${agent.role}: prompt was not submitted; pressed Enter (attempt ${attempt})`, { quiet: true });
      emit('prompt_resubmitted', { role: agent.role, attempt });
      return r.agent.agent_status;
    }
  }
  return null;
}

// A session that has not seen its assignment (new message type or a restarted agent without
// its old session) gets the role template plus the assignment; a live session gets the step only.
export function composeText(msg, resultPath, needsAssignment) {
  if (!needsAssignment) {
    return `${msg.text}\n\nYour assignment is still ${state.cur.assignments[msg.role]}. `
      + `Write this step's result JSON (same format) to: ${resultPath}`;
  }
  return `/${TEMPLATE[msg.role]} Read and execute the relay assignment at ${state.cur.assignments[msg.role]}`
    + (msg.initial ? '' : `\n\nThen, as the current step: ${msg.text}`)
    + `\n\nResult file for this step: ${resultPath}`;
}

export function send(msg) {
  const notes = state.cur.notes?.[msg.role];
  if (notes) {
    msg = { ...msg, text: `${notes}\n\n${msg.text}` };
    delete state.cur.notes[msg.role];
  }
  const { agent, fresh } = ensureAgent(msg.role);
  const slice = currentSlice();
  const resultPath = resultPathFor(msg.role, msg.purpose);
  if (msg.initial || !state.cur.assignments[msg.role]) {
    state.cur.assignments[msg.role] = writeAssignment(msg.role, msg.purpose, slice, msg.text);
  }
  const text = composeText(msg, resultPath, msg.initial || fresh);
  quotaGate(msg.role);
  state.cur.pending = {
    ...msg, resultPath, sentText: text, sentAt: Date.now(), firstSentAt: Date.now(), agent: agent.name,
    startUsage: { session: agent.session, totals: sessionTotals(agent.session) },
  };
  emit('step_sent', { role: msg.role, purpose: msg.purpose, agent: agent.name, resultPath, newAssignment: Boolean(msg.initial || fresh) });
  state.cur.queued = null;
  save();
  log(`${slice.id} → ${msg.role} (${msg.purpose})`, { quiet: true });
  event(C.cyan('\u2192'), `${roleTag(msg.role)} ${purposeLabel(msg.purpose)}`);
  settle(agent, prompt(agent, text));
  return collect();
}

// ---------- advisor: plain-language decisions for the owner ----------
// A worker's needs-decision goes to a fresh advisor session, which writes a brief (options and a
// recommendation in plain words), takes the owner's answer in its own tab, and writes the decision
// plus replies. The relay records the decision in decisions.md and delivers the replies.

// Finish the pending exchange: wait, nudge once for a missing result, involve the operator when asked.
// Also used on resume, when the agent may have died or never received the message.
export function collect() {
  const p = state.cur.pending;
  let nudged = false;
  for (;;) {
    const { agent, fresh } = ensureAgent(p.role);
    const liveAgent = agentAlive(agent);
    if (liveAgent && ['working', 'blocked'].includes(liveAgent.agent_status)) settle(agent, liveAgent.agent_status);
    if (p.runaway) {
      return { status: 'runaway', summary: `Interrupted after ${plural(p.runaway.compactions, 'compaction')} and ${plural(p.runaway.turns, 'turn')} in one step.` };
    }
    let r = readResult(p.resultPath, p.sentAt);
    if (!r && agent.name !== p.agent) {
      // Restarted agent: deliver the step again rather than nudging about a message it never saw.
      p.agent = agent.name;
      p.sentAt = Date.now();
      save();
      emit('redeliver', { role: p.role, purpose: p.purpose, agent: agent.name });
      log(`${state.cur.slice} re-delivering ${p.role} (${p.purpose}) to restarted agent`, { quiet: true });
      event(C.gray('\u21ba'), `${roleTag(p.role)} ${C.dim(`re-sending "${p.purpose}" to the restarted session`)}`);
      settle(agent, prompt(agent, composeText(p, p.resultPath, p.initial || fresh)));
      continue;
    }
    if (r && r.status === 'needs-decision' && advisorEnabled() && p.role !== 'advisor') {
      const outcome = consultAdvisor(agent, p, r);
      if (outcome === 'set-aside') return { status: 'set-aside' }; // a prerequisite slice runs first
      if (outcome) continue; // the worker has the owner's decision; collect its next result
    }
    if (r && HUMAN_STATUSES.has(r.status)) {
      r = waitForOperator(agent, r);
      if (p.runaway) {
        return { status: 'runaway', summary: `Interrupted after ${plural(p.runaway.compactions, 'compaction')} and ${plural(p.runaway.turns, 'turn')} in one step.` };
      }
    }
    if (valid(p.role, r)) return r;
    // Over the compaction limit and stopped without a result: same as a runaway, no reminder.
    const used = stepUsage(p);
    const limit = cfg.maxCompactionsPerStep ?? 3;
    if (!r && used && limit > 0 && used.compactions >= limit) {
      markRunaway(agent, p, used, false);
      return { status: 'runaway', summary: `Stopped after ${plural(used.compactions, 'compaction')} and ${plural(used.turns, 'turn')} in one step.` };
    }
    // No work at all since the step was sent: its prompt is probably still unsent in the input box
    // (typing a reminder now would append to it). Submit it instead.
    if (!r && !p.submitRetried && (used?.turns ?? 0) === 0) {
      p.submitRetried = true;
      save();
      const status = submitPendingInput(agent);
      if (status) { settle(agent, status); continue; }
    }
    // A worker cut off by a usage limit stops without a result: wait for quota, then let it continue.
    if (!r && quotaGate(p.role)) nudged = false;
    if (nudged) {
      waitForOperator(agent, { status: 'blocked', question: 'Worker stopped without a valid result file.', _path: p.resultPath, _mtime: r?._mtime ?? 0 });
      continue;
    }
    nudged = true;
    const problem = r ? `Your result file is invalid (${r.summary ?? `status "${r.status}"`}).`
      : 'You stopped without writing the result file (possibly cut off by a provider error). If your step is unfinished, continue it now.';
    emit('nudge', { role: p.role, purpose: p.purpose, reason: r ? 'invalid-result' : 'missing-result' });
    log(`${state.cur.slice} ${p.role}: ${problem} Nudging once.`, { quiet: true });
    event(C.yellow('!'), `${roleTag(p.role)} ${C.yellow('no valid result yet')} ${C.dim('\u00b7 reminding it once')}`, problem);
    p.sentAt = Date.now();
    save();
    settle(agent, prompt(agent, `${problem} Then write the result to ${p.resultPath} using the format in your assignment. `
      + 'Use status "blocked" only if you genuinely cannot continue.'));
  }
}

export function showQuestion(agent, r) {
  log(`${state.cur.slice} ${agent.role} ${r.status}: ${r.question ?? r.summary ?? ''}`, { quiet: true });
  notify(`Relay ${ctx.topic}: ${agent.role} ${r.status}`, `${r.question ?? r.summary ?? ''}\nAnswer in tab "${agent.label}".`);
  const color = r.status === 'blocked' ? C.red : C.magenta;
  callout(color, `${agent.role} ${r.status === 'blocked' ? 'is blocked' : 'needs a decision'} \u2014 waiting for you`, [
    r.question ?? r.summary ?? '',
    C.dim(`Answer in tab "${agent.label}". The relay resumes when the ${agent.role} rewrites its result file.`),
  ]);
}

// Wait for the operator to answer a worker in its own tab. Once the worker is working on the answer,
// show the live line and apply the compaction limit, exactly as for any other step. Returns the
// worker's next non-question result, or null when the step was interrupted as a runaway.
export function waitForOperator(agent, r, { show = showQuestion, track = true } = {}) {
  let waitStart = Date.now();
  let answered = false;
  emit('operator_wait_start', { role: agent.role, status: r.status, question: r.brief?.question ?? r.question ?? r.summary ?? null });
  show(agent, r);
  for (;;) {
    sleep(10000);
    const liveAgent = agentAlive(agent);
    if (!liveAgent) throw new RelayStop(`The ${agent.role} tab was closed while waiting for an answer. Re-run pi-relay ${ctx.topic} to continue.`);
    const next = readResult(r._path, r._mtime + 1);
    if (next && next._mtime > r._mtime) {
      if (!answered) emit('operator_wait_end', { role: agent.role, waitedMs: Date.now() - waitStart });
      if (!HUMAN_STATUSES.has(next.status)) {
        clearLive();
        log(`${state.cur.slice} ${agent.role} finished after operator input`, { quiet: true });
        return next;
      }
      r = next; // it asks again
      answered = false;
      waitStart = Date.now();
      emit('operator_wait_start', { role: agent.role, status: r.status, question: r.brief?.question ?? r.question ?? r.summary ?? null });
      show(agent, r);
      continue;
    }
    const p = state.cur.pending;
    const status = liveAgent.agent_status;
    if (status === 'working' && !answered) {
      answered = true;
      emit('operator_wait_end', { role: agent.role, waitedMs: Date.now() - waitStart });
      log(`${state.cur.slice} ${agent.role} resumed after operator input`, { quiet: true });
      event(C.green('\u21b3'), `${roleTag(agent.role)} ${C.dim('working on your answer')}`);
    }
    if (!answered) continue;
    const u = track && p ? stepUsage(p) : null;
    const limit = cfg.maxCompactionsPerStep ?? 3;
    if (status === 'working' && u && limit > 0 && u.compactions >= limit && !p.runaway) {
      interruptRunaway(agent, p, u);
      return null;
    }
    const facts = [status === 'working' ? 'working' : status === 'blocked' ? 'waiting on a prompt in its tab' : 'idle in its tab'];
    facts.push(fmtDuration(Date.now() - (track ? (p?.firstSentAt ?? p?.sentAt ?? waitStart) : waitStart)));
    if (u) facts.push(plural(u.turns, 'turn'));
    live(`  ${C.gray(hhmm())}  ${C.cyan('\u25f7')} ${roleTag(agent.role)} ${C.dim(facts.join(' \u00b7 '))}`
      + (u ? `${C.dim(' \u00b7 ')}${compactionText(u.compactions)}` : ''));
  }
}

// ---------- transitions ----------
