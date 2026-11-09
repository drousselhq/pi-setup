// pi-relay: Assignments, result files, sending a step and collecting its result (waiting is in waiting.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { advisorEnabled, consultAdvisor } from './advisor.mjs';
import { acceptanceProblem, setAsideNote } from './acceptance.mjs';
import { agentAlive, ensureAgent } from './agents.mjs';
import { moveAside } from './fresh.mjs';
import { C, emit, event, log, purposeLabel, roleTag } from './console.mjs';
import { quotaGate } from './quota.mjs';
import { cfg, ctx, HUMAN_STATUSES, plural, state, STATUSES, TEMPLATE } from './runtime.mjs';
import { save } from './store.mjs';
import { currentSlice } from './transitions.mjs';
import { sessionTotals, stepUsage } from './usage.mjs';
import { agentTurns, markRunaway, prompt, settle, submitPendingInput, waitForOperator } from './waiting.mjs';

export function sliceDir(id) {
  const dir = path.join(ctx.topicDir, 'slices', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function artifactPath(role, sliceId) {
  if (role === 'planner') return ctx.plan;
  const file = { scout: 'scout.md', architect: 'architecture.md', acceptance: 'acceptance.md', implementer: 'implementation.md', senior: 'implementation.md', reviewer: 'review.md', advisor: 'advice.md' }[role];
  return path.join(sliceDir(sliceId), file);
}

export function gitRules(role) {
  if (role === 'acceptance') {
    return 'Write only new files: the tests (and their expectation fixtures) for this slice, your artifact and the result file. '
      + 'Do not edit existing files. No Git writes.';
  }
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
  const others = ['scout', 'architect', 'acceptance', 'implementer', 'reviewer']
    .filter((r) => r !== role && slice.id !== 'PLAN')
    .map((r) => artifactPath(r, slice.id))
    .filter((p) => fs.existsSync(p) && p !== artifactPath(role, slice.id));
  const reviewerFields = role === 'reviewer'
    ? '\n  "verdict": "accept | changes-required",   // required when status is done\n  "blocking": ["R1"],                       // IDs of findings that must be fixed; empty when accepting'
    : '';
  const testFields = role === 'acceptance'
    ? '\n  "tests": ["path/of/a/new/file"],          // with status done: every file you created, relative to the project checkout'
    : '';
  const questionFields = role === 'advisor' ? '' : '\n  "options": [{ "label": "...", "consequence": "..." }],  // with needs-decision: 2-4 real options'
    + '\n             // an option may propose a prerequisite slice: add "slice": { "title": "...", "acceptance": ["..."], "notes": "..." }'
    + '\n  "recommended": 1, "reason": "why you recommend it",   // with needs-decision';
  const deferral = `{ ${Object.keys(DEFERRAL_FIELDS).map((k) => `"${k}": "..."`).join(', ')} }`;
  const advisorFields = role !== 'advisor' ? '' : `
  // status needs-decision (the brief for the owner):
  "brief": { "title": "...", "question": "...", "context": "...",
             "options": [{ "label": "...", "consequence": "..." }],  // the recommended option first
             // an option that postpones the decision also carries
             // "deferral": ${deferral}   (${Object.values(DEFERRAL_FIELDS).join(', ')})
             // with the advisory council enabled, each option also has "action": "exact technical action", "classes": ["A"]
             "recommended": 1, "reason": "...", "notes": [], "ownerNeeded": null },
  // status done (after the owner chose):
  "title": "short decision title", "decision": "the decision as it should be recorded",
  "deferral": ${deferral},  // only when the owner chose to postpone
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
- Decisions so far (the owner's, and the advisory council's where enabled): ${ctx.decisions}${fs.existsSync(ctx.decisions) ? '' : ' (none yet)'}.
  Read it before you start; never ask again about something it already settles.
- Your artifact: ${artifactPath(role, slice.id)}
${others.length ? `- Other artifacts for this slice: ${others.join(', ')}\n` : ''}
Pre-existing uncommitted changes when the relay started (not this work; never stage, revert or edit them):
\`\`\`
${state.startStatus || '(none)'}
\`\`\`
${setAsideNote()}
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
  "question": "the one precise question, only for needs-* or blocked",${reviewerFields}${testFields}${questionFields}${advisorFields}
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

// Why a result with an allowed status is still unusable, in words the worker can act on; null when usable.
export function resultProblem(role, r) {
  if (role === 'reviewer' && r.status === 'done') {
    if (!['accept', 'changes-required'].includes(r.verdict)) return '"verdict" must be "accept" or "changes-required"';
    const blocking = r.blocking ?? [];
    if (!Array.isArray(blocking)) return '"blocking" must be a list of finding IDs';
    if (r.verdict === 'accept' && blocking.length) {
      return `verdict "accept" lists blocking findings (${blocking.join(', ')}): accept only with none, or set "changes-required"`;
    }
    if (r.verdict === 'changes-required' && !blocking.length) {
      return 'verdict "changes-required" lists no blocking finding: give their IDs in "blocking", or accept';
    }
  }
  if (role === 'acceptance' && r.status === 'done') return acceptanceProblem(r);
  return null;
}

export function valid(role, r) {
  if (!r || !STATUSES[role].includes(r.status)) return false;
  if (resultProblem(role, r)) return false;
  if (role === 'advisor' && r.status === 'done') {
    return typeof r.decision === 'string' && r.decision.trim() !== '' && (r.slice === undefined || r.slice === null || validSliceSpec(r.slice))
      && (r.deferral === undefined || r.deferral === null || validDeferral(r.deferral));
  }
  return true;
}

// A postponed decision must say what is missing, where it comes from, when it is decided anyway and
// what happens until then.
export const DEFERRAL_FIELDS = { missing: 'Missing information', source: 'Expected from', decisionPoint: 'Decided at', interim: 'Until then' };
export const validDeferral = (d) => Boolean(d) && typeof d === 'object'
  && Object.keys(DEFERRAL_FIELDS).every((k) => typeof d[k] === 'string' && d[k].trim() !== '');

// A prerequisite slice chosen by the owner: one-line title and at least one acceptance condition.
export function validSliceSpec(s) {
  const line = (x) => typeof x === 'string' && x.trim() !== '' && !x.includes('\n');
  return Boolean(s) && line(s.title) && Array.isArray(s.acceptance) && s.acceptance.length > 0 && s.acceptance.every(line)
    && (s.notes === undefined || typeof s.notes === 'string');
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
  moveAside(msg.moveRecord); // a --fresh replacement whose record move a kill interrupted
  // A role's notes stay saved until the pending step that carries them is: starting a worker saves state.
  const notes = state.cur.notes?.[msg.role];
  if (notes) msg = { ...msg, text: `${notes}\n\n${msg.text}` };
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
    delivered: false, // saved before the prompt; set once Herdr accepted it (see collect() for a kill between)
    deliveryTurns: agentTurns(agent),
  };
  emit('step_sent', { role: msg.role, purpose: msg.purpose, agent: agent.name, resultPath, newAssignment: Boolean(msg.initial || fresh) });
  if (notes) delete state.cur.notes[msg.role];
  state.cur.queued = null;
  save();
  log(`${slice.id} → ${msg.role} (${msg.purpose})`, { quiet: true });
  event(C.cyan('\u2192'), `${roleTag(msg.role)} ${purposeLabel(msg.purpose)}`);
  const status = prompt(agent, text);
  state.cur.pending.delivered = true;
  save();
  settle(agent, status);
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
  // A transition that failed after closing this worker left its finished result pending (see
  // transition()): replay that result rather than starting a new worker to ask again.
  if (!state.cur.agents[p.role] && !p.runaway) {
    const done = readResult(p.resultPath, p.sentAt);
    if (valid(p.role, done) && !HUMAN_STATUSES.has(done.status)) return done;
  }
  let nudged = false;
  const routesDecisions = advisorEnabled() && p.role !== 'advisor';
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
      p.sentText = composeText(p, p.resultPath, p.initial || fresh);
      p.delivered = false;
      p.deliveryTurns = agentTurns(agent);
      save();
      emit('redeliver', { role: p.role, purpose: p.purpose, agent: agent.name });
      log(`${state.cur.slice} re-delivering ${p.role} (${p.purpose}) to restarted agent`, { quiet: true });
      event(C.gray('\u21ba'), `${roleTag(p.role)} ${C.dim(`re-sending "${p.purpose}" to the restarted session`)}`);
      const status = prompt(agent, p.sentText);
      p.delivered = true;
      save();
      settle(agent, status);
      continue;
    }
    if (!r && p.delivered === false) {
      // Killed between the prompt and its marker: the same agent that has worked since received it; one that
      // has not may hold it unsent in its input box (Enter); otherwise it gets it again.
      const status = agentTurns(agent) > (p.deliveryTurns ?? 0) ? 'working' : submitPendingInput(agent) ?? prompt(agent, p.sentText);
      p.delivered = true;
      save();
      settle(agent, status);
      continue;
    }
    if (r && r.status === 'needs-decision' && routesDecisions) {
      const outcome = consultAdvisor(agent, p, r);
      if (outcome === 'set-aside') return { status: 'set-aside' }; // a prerequisite slice runs first
      if (outcome) continue; // the worker has the owner's decision; collect its next result
    }
    if (r && HUMAN_STATUSES.has(r.status)) {
      r = waitForOperator(agent, r, { decisions: routesDecisions });
      if (r?.status === 'needs-decision') continue; // the worker's new question goes to the advisor
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
      const invalid = r && STATUSES[p.role].includes(r.status) ? resultProblem(p.role, r) : null;
      const question = invalid ? `The worker's result file is still invalid: ${invalid}.` : 'Worker stopped without a valid result file.';
      waitForOperator(agent, { status: 'blocked', question, _path: p.resultPath, _mtime: r?._mtime ?? 0 },
        { decisions: routesDecisions });
      continue; // a valid result, or a new question for the advisor, is read at the top of the loop
    }
    nudged = true;
    const why = r && STATUSES[p.role].includes(r.status) ? resultProblem(p.role, r) : null;
    const problem = r ? `Your result file is invalid (${why ?? r.summary ?? `status "${r.status}"`}).`
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

// ---------- transitions ----------
