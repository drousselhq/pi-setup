// pi-relay: The advisory council: two members on different models vote independently on the advisor's
// brief; the relay decides only when both choose the same option and nothing reserves it to the owner.

import fs from 'node:fs';
import path from 'node:path';
import { agentAlive, ensureAgent } from './agents.mjs';
import { C, clearLive, emit, event, fmtDuration, hhmm, live, log, roleTag, shortModel } from './console.mjs';
import { quotaGate } from './quota.mjs';
import { cfg, ctx, herdr, notify, RelayStop, sleep, state, TEMPLATE } from './runtime.mjs';
import { validSliceSpec } from './steps.mjs';
import { save } from './store.mjs';
import { agentTurns, permissionNotice, submitPendingInput, wroteSince } from './waiting.mjs';

// The decision classes (relay protocol). The owner keeps cfg.council.ownerClasses (default E to I).
export const CLASSES = {
  A: 'Technical choice within the approved scope: behaviour, method, test approach',
  B: 'Meaning of an unclear acceptance clause or handoff, without lowering it',
  C: "Touching files outside a slice's listed paths, within the topic's handoff",
  D: 'Deferring work to a later slice, the backlog or an already scheduled point, without dropping required work',
  E: 'Widening scope: new features, behaviour beyond the handoff, roadmap changes',
  F: 'Product direction and user experience',
  G: 'Tooling and infrastructure strategy: new dependencies, harnesses, external services',
  H: 'Changes to project rules and contracts: instructions, ADRs, verification gates and thresholds, acceptance criteria',
  I: 'Irreversible or external effects: published formats, data migration, deleting evidence, pushing, money, credentials, licences',
};
const DEFAULT_OWNER_CLASSES = ['E', 'F', 'G', 'H', 'I'];
const CONFIDENCE = ['high', 'medium', 'low'];
const REVERSIBILITY = ['easy', 'costly', 'irreversible'];

export const councilEnabled = () => cfg.council?.enabled === true;
const ownerClasses = () => cfg.council?.ownerClasses ?? DEFAULT_OWNER_CLASSES;
const clip = (x) => String(x).trim().replace(/[\s.;]+$/, ''); // reasons are joined with "; "
export const validClasses = (x) => Array.isArray(x) && x.length > 0 && x.every((k) => Object.hasOwn(CLASSES, k));

export function classTable() {
  return ['| Class | Covers |', '|---|---|', ...Object.entries(CLASSES).map(([k, v]) => `| ${k} | ${v} |`)].join('\n')
    + `\n\nThe owner keeps classes ${ownerClasses().join(', ')}; the council may decide only the others.`;
}

// A malformed council configuration stops the run: it must never silently shrink the council.
export function checkCouncilConfig() {
  if (!councilEnabled()) return;
  const members = cfg.council.members;
  const problems = [];
  if (!Array.isArray(members) || members.length !== 2 || new Set(members).size !== 2) {
    problems.push('council.members must name exactly two distinct roles');
  } else {
    for (const r of members) {
      if (Object.hasOwn(TEMPLATE, r)) problems.push(`council member "${r}" must not be a worker or advisor role`);
      else if (!cfg.roles?.[r]?.model) problems.push(`council member "${r}" has no model (roles.${r}.model)`);
    }
    if (!problems.length && cfg.roles[members[0]].model === cfg.roles[members[1]].model) problems.push('the two council members must use different models');
  }
  const oc = cfg.council.ownerClasses;
  if (oc !== undefined && (!Array.isArray(oc) || !oc.every((k) => Object.hasOwn(CLASSES, k)))) {
    problems.push(`council.ownerClasses must list class letters (${Object.keys(CLASSES).join(', ')})`);
  }
  const t = cfg.council.timeoutMinutes;
  if (t !== undefined && !(typeof t === 'number' && t > 0)) problems.push('council.timeoutMinutes must be a positive number');
  if (problems.length) throw new RelayStop(`Invalid council configuration: ${problems.join('; ')}. Fix config.json or the topic's relay.json.`);
}

// What the advisor's brief still needs when the council is enabled; null when complete.
// Every field of an option that would bind if the council chose it must be valid before the vote.
export function councilBriefProblem(b) {
  const bad = b.brief.options.findIndex((o) => typeof o?.action !== 'string' || !o.action.trim() || !validClasses(o.classes));
  if (bad >= 0) {
    return `The advisory council is enabled: option ${bad + 1} needs "action" (what workers will do, exact and technical) `
      + 'and "classes" (letters from the class table in your assignment).';
  }
  // (An option's deferral is already checked for every brief, by briefProblem() in advisor.mjs.)
  const slice = b.brief.options.findIndex((o) => o.slice !== undefined && o.slice !== null && !validSliceSpec(o.slice));
  if (slice >= 0) return `Option ${slice + 1}'s prerequisite "slice" needs a one-line "title" and at least one one-line "acceptance" condition.`;
  const on = b.brief.ownerNeeded;
  if (on !== undefined && on !== null && (typeof on !== 'string' || !on.trim())) return '"ownerNeeded" must be null or the reason the owner must decide.';
  return null;
}

// Reasons to ask the owner without consulting the council: the advisor says so, or recommends an
// option in a class the owner keeps.
export function advisorOwnerReasons(b) {
  const reasons = [];
  if (b.brief.ownerNeeded) reasons.push(`the advisor: ${clip(b.brief.ownerNeeded)}`);
  const owned = b.brief.options[0].classes.filter((k) => ownerClasses().includes(k));
  if (owned.length) reasons.push(`the recommended option is class ${owned.join(', ')}, which you keep`);
  return reasons;
}

// The vote file format, written into each member's assignment; voteProblem() checks the same fields.
export function voteFormat(ids) {
  return `\`\`\`
{
  "status": "done",
  "choice": "${[...ids, 'new'].join(' | ')}",   // an option ID, or "new" when every listed option is clearly wrong
  "newOption": "only with \\"new\\": the full action workers would take",
  "conditions": ["limits you add to the chosen action; empty if none"],
  "classes": ["A"],                  // letters from the class table: the chosen action and its effects
  "ownerNeeded": null,               // or why the owner must decide even if both members agree
  "confidence": "${CONFIDENCE.join(' | ')}",
  "reversibility": "${REVERSIBILITY.join(' | ')}",
  "reasons": "why this option, with the evidence that decides it (paths, lines, facts)",
  "objection": "the strongest objection to your own choice, and why it does not change it",
  "ownerSummary": "for the owner, in plain everyday words: what you propose, why, how sure you are and why, the alternatives you weighed"
}
\`\`\``;
}

export function voteProblem(v, ids) {
  if (!v) return 'You stopped without writing your vote.';
  if (v.status === 'invalid') return `Your vote file is invalid (${v.summary}).`;
  const wrong = [];
  if (v.status !== 'done') wrong.push('"status" must be "done"');
  if (!ids.includes(v.choice) && !(v.choice === 'new' && typeof v.newOption === 'string' && v.newOption.trim())) {
    wrong.push(`"choice" must be one of ${ids.join(', ')}, or "new" with "newOption"`);
  }
  if (!validClasses(v.classes)) wrong.push('"classes" must list class letters');
  if (!CONFIDENCE.includes(v.confidence)) wrong.push(`"confidence" must be ${CONFIDENCE.join(' | ')}`);
  if (!REVERSIBILITY.includes(v.reversibility)) wrong.push(`"reversibility" must be ${REVERSIBILITY.join(' | ')}`);
  if (v.ownerNeeded !== undefined && v.ownerNeeded !== null && typeof v.ownerNeeded !== 'string') wrong.push('"ownerNeeded" must be null or a reason');
  if (v.conditions !== undefined && !(Array.isArray(v.conditions) && v.conditions.every((x) => typeof x === 'string'))) wrong.push('"conditions" must be a list of strings');
  for (const k of ['reasons', 'ownerSummary']) if (typeof v[k] !== 'string' || !v[k].trim()) wrong.push(`"${k}" is required`);
  return wrong.length ? `Your vote is incomplete: ${wrong.join('; ')}.` : null;
}

function writeAssignment(role, slice, a, n) {
  const file = path.join(ctx.relayDir, `${String(++state.seq).padStart(3, '0')}-${role}.md`);
  const b = a.brief.brief;
  const options = a.council.order.map((i, k) => {
    const o = b.options[i];
    // Members see every field that binds if both choose this option (the relay records it as written).
    const extra = [o.deferral ? `Postpones the decision: missing ${o.deferral.missing}; from ${o.deferral.source}; decided at ${o.deferral.decisionPoint}; until then ${o.deferral.interim}.` : '',
      o.slice ? `First inserts a prerequisite slice: "${o.slice.title}", acceptance: ${o.slice.acceptance.join('; ')}.${o.slice.notes ? ` Notes: ${o.slice.notes}` : ''}` : '']
      .filter(Boolean).join(' ');
    return `- **${a.council.ids[k]}**: ${o.label}. Action: ${o.action}${extra ? ` ${extra}` : ''}`;
  });
  fs.writeFileSync(file, `# Council assignment: ${role} for ${slice.id} — ${slice.title}

You are member ${n} of the relay's advisory council. Judge the question below independently: the other member
does not see your vote, and you do not see theirs. Do not edit any file except your vote file; no Git writes.

- Project checkout: ${ctx.project}
- Topic folder: ${ctx.topicDir}
- Handoff: ${fs.existsSync(ctx.handoff) ? ctx.handoff : '(none)'}
- Plan: ${fs.existsSync(ctx.plan) ? ctx.plan : '(none)'}
- Decisions so far: ${fs.existsSync(ctx.decisions) ? ctx.decisions : '(none yet)'}
- The waiting worker: the ${a.workerRole}. Its result, with its question and options: ${a.workerResult}
- The project's own instructions: its AGENTS.md or equivalent, and the decision records they point to.

## Question

${b.question}

${b.context ?? ''}

## Options (neutral order; none is recommended)

${options.join('\n')}

## Decision classes

${classTable()}

## Your vote

Write it to ${a.council.members[role].votePath} as JSON, in this format:

${voteFormat(a.council.ids)}
`);
  return file;
}

function closeMember(role) {
  const agent = state.cur.agents[role];
  if (agent) herdr(['tab', 'close', agent.tab], { allowFail: true }); // never wait for a member: late votes are ignored
  delete state.cur.agents[role];
  save();
}

function fail(role, m, why) {
  m.failed = why;
  save();
  emit('council_vote', { member: role, model: m.model, failed: why });
  event(C.yellow('\u26a0'), `${roleTag(role)} ${C.yellow('no vote')} ${C.dim(`\u00b7 ${why}`)}`);
  log(`${state.cur.slice} council ${role} failed: ${why}`, { quiet: true });
}

// Starts or resumes the vote and returns the outcome: { decided: option index, conditions } or { owner: [reasons] }.
export function runCouncil(a, slice) {
  const opts = a.brief.brief.options;
  if (!a.council) {
    const order = opts.map((_, i) => i).sort((x, y) => opts[x].label.localeCompare(opts[y].label));
    a.council = { order, ids: order.map((_, k) => `X${k + 1}`), ownerClasses: ownerClasses(), members: {} };
    for (const [n, role] of cfg.council.members.entries()) {
      a.council.members[role] = { model: cfg.roles[role].model, thinking: cfg.roles[role].thinking ?? 'medium', votePath: path.join(ctx.relayDir, `${String(++state.seq).padStart(3, '0')}-${role}-vote.result.json`) };
      a.council.members[role].assignment = writeAssignment(role, slice, a, n + 1);
    }
    save();
    emit('council_start', { options: opts.length, members: Object.fromEntries(Object.entries(a.council.members).map(([r, m]) => [r, m.model])) });
    event(C.magenta('\u2696'), `${C.magenta('advisory council')} ${C.dim(`\u00b7 ${Object.entries(a.council.members).map(([r, m]) => `${r} ${shortModel(m.model)}`).join(', ')} vote independently`)}`);
  }
  const cn = a.council;
  if (!cn.outcome) {
    for (const [role, m] of Object.entries(cn.members)) {
      if (m.sentAt || m.failed) continue;
      try {
        quotaGate(role);
        const { agent } = ensureAgent(role);
        // At least once, never twice (see promptOnce()): a member that worked since an attempt got it.
        // Its vote file counts from the attempt's time, so a vote written before a restart is read.
        const got = m.prompting && (wroteSince(m.votePath, m.prompting.at)
          || (m.prompting.agent === agent.name && (agentTurns(agent) > m.prompting.turns || submitPendingInput(agent))));
        if (!got) {
          m.prompting = { agent: agent.name, turns: agentTurns(agent), at: Date.now() };
          save();
          herdrPrompt(agent, `/council Read and execute the council assignment at ${m.assignment}\n\nVote file: ${m.votePath}`);
        }
        m.sentAt = m.prompting.at;
        m.prompting = null;
        save();
      } catch (e) {
        fail(role, m, `could not start: ${e.message}`);
      }
    }
    waitForVotes(cn);
    for (const role of Object.keys(cn.members)) closeMember(role);
    cn.outcome = compare(cn, opts);
    save();
    if (cn.outcome.owner) {
      emit('council_escalation', { reasons: cn.outcome.owner });
      event(C.magenta('\u2696'), `${C.magenta('council')} ${C.dim('\u00b7 sends the question to you')}`, cn.outcome.owner.join('; '));
    }
  }
  return cn.outcome;
}

// Submit without waiting for the member to finish, so both work at the same time.
function herdrPrompt(agent, text) {
  const r = herdr(['agent', 'prompt', agent.name, text, '--wait', '--until', 'working', '--until', 'blocked'], { allowFail: true });
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
}

function waitForVotes(cn) {
  const limit = (cfg.council.timeoutMinutes ?? 30) * 60_000;
  const started = Math.min(...Object.values(cn.members).map((m) => m.sentAt ?? Date.now()));
  for (;;) {
    const open = Object.entries(cn.members).filter(([, m]) => !m.vote && !m.failed);
    if (!open.length) { clearLive(); return; }
    for (const [role, m] of open) {
      const v = readVote(m.votePath, m.sentAt);
      const problem = voteProblem(v, cn.ids);
      if (!problem) {
        m.vote = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));
        save();
        emit('council_vote', { member: role, model: m.model, choice: v.choice, classes: v.classes, confidence: v.confidence, reversibility: v.reversibility, ownerNeeded: Boolean(v.ownerNeeded) });
        event(C.green('\u2713'), `${roleTag(role)} ${C.dim(`voted \u00b7 ${v.confidence} confidence \u00b7 class ${v.classes.join(', ')}`)}`);
        continue;
      }
      const agent = state.cur.agents[role];
      const status = agent && agentAlive(agent)?.agent_status;
      if (!status) { fail(role, m, 'its agent is gone'); continue; }
      if (status === 'working' || status === 'blocked' || status === 'unknown') {
        if (status === 'blocked' && !m.blockedNotified) {
          m.blockedNotified = true;
          const { screen } = permissionNotice(agent);
          emit('permission_wait', { role, screen });
        }
        if (Date.now() - m.sentAt > limit) fail(role, m, `no vote after ${fmtDuration(limit)}`);
        continue;
      }
      if (m.corrected) { fail(role, m, problem); continue; }
      m.corrected = true;
      m.sentAt = Date.now();
      save();
      try { herdrPrompt(agent, `${problem} Write it to ${m.votePath} in the format your assignment gives.`); } catch (e) { fail(role, m, e.message); }
    }
    if (Object.values(cn.members).some((m) => !m.vote && !m.failed)) {
      live(`  ${C.gray(hhmm())}  ${C.cyan('\u25f7')} ${roleTag('council')} ${C.dim(`voting \u00b7 ${fmtDuration(Date.now() - started)}`)}`);
      sleep(10000);
    }
  }
}

function readVote(file, since) {
  if (!since || !fs.existsSync(file) || fs.statSync(file).mtimeMs < since - 2000) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { status: 'invalid', summary: `unparseable JSON: ${e.message}` }; }
}

function compare(cn, opts) {
  const members = Object.entries(cn.members);
  const failed = members.filter(([, m]) => m.failed).map(([r, m]) => `${r} gave no usable vote (${clip(m.failed)})`);
  if (failed.length) return { owner: failed };
  const votes = members.map(([role, m]) => ({ role, ...m.vote }));
  const reasons = [];
  for (const v of votes) {
    const owned = v.classes.filter((k) => cn.ownerClasses.includes(k));
    if (owned.length) reasons.push(`${v.role} puts its choice in class ${owned.join(', ')}, which you keep`);
    if (v.ownerNeeded) reasons.push(`${v.role}: ${clip(v.ownerNeeded)}`);
    if (v.reversibility === 'irreversible') reasons.push(`${v.role} judges its choice irreversible`);
    if (v.choice === 'new') reasons.push(`${v.role} proposes an option the brief does not list`);
  }
  if (votes.every((v) => v.confidence === 'low')) reasons.push('both members have low confidence');
  if (new Set(votes.map((v) => v.choice)).size > 1) reasons.push('the members chose different options');
  if (!reasons.length) {
    const index = cn.order[cn.ids.indexOf(votes[0].choice)];
    const owned = opts[index].classes.filter((k) => cn.ownerClasses.includes(k));
    if (!owned.length) return { decided: index, conditions: votes.flatMap((v) => v.conditions ?? []) };
    reasons.push(`the advisor puts the chosen option in class ${owned.join(', ')}, which you keep`);
  }
  return { owner: reasons };
}

// The council's decision, built by the relay from what both members voted for: the chosen option as the
// advisor wrote it and the members' conditions. Nothing is rewritten between the vote and the workers.
export function councilDecision(a, outcome) {
  const o = a.brief.brief.options[outcome.decided];
  const conditions = outcome.conditions.map((x) => String(x).trim()).filter(Boolean);
  const limits = conditions.length ? `\nConditions the members added (they limit the action):\n${conditions.map((x) => `- ${x}`).join('\n')}` : '';
  const interim = o.deferral ? `\nThe decision itself is postponed until ${o.deferral.decisionPoint}. Until then: ${o.deferral.interim}` : '';
  const first = o.slice ? `\nA prerequisite slice runs first: "${o.slice.title}"; acceptance: ${o.slice.acceptance.join('; ')}.`
    + `${o.slice.notes ? ` Notes: ${o.slice.notes}` : ''}` : '';
  const binding = `Action: ${o.action}${limits}${interim}\nThis is binding: do not change the action. If you cannot satisfy it and its `
    + 'conditions together, report needs-decision saying why instead of working around it.';
  const replies = { [a.workerRole]: binding };
  if (a.workerRole !== 'reviewer') replies.reviewer = 'It applies to this slice: check that its action and conditions were followed.';
  return {
    status: 'done', title: o.label, chosen: outcome.decided + 1, replies,
    // The record: the deferral's fields follow it in their own block (recordDecision()).
    decision: `The advisory council decided: ${o.label}.\nAction: ${o.action}${limits}${first}`,
    ...(o.deferral ? { deferral: o.deferral } : {}),
    ...(o.slice ? { slice: o.slice } : {}),
  };
}

// Notes for the owner's brief: why it came to them and what each member proposed, in their plain words.
export function ownerNotes(a) {
  const cn = a.council;
  const label = (choice) => (choice === 'new' ? 'an option of its own' : `"${a.brief.brief.options[cn.order[cn.ids.indexOf(choice)]].label}"`);
  return [
    `The advisory council sent this to you: ${cn.outcome.owner.join('; ')}.`,
    ...Object.values(cn.members).filter((m) => m.vote)
      .map((m) => `${shortModel(m.model)} would choose ${label(m.vote.choice)} (${m.vote.confidence} confidence): ${m.vote.ownerSummary}`),
  ];
}

// The decisions.md attribution of a council decision.
export function councilAttribution(a) {
  const votes = Object.values(a.council.members).map((m) => m.vote);
  const classes = [...new Set(votes.flatMap((v) => v.classes))].sort().join(', ');
  const rev = REVERSIBILITY.filter((x) => votes.some((v) => v.reversibility === x)).at(-1);
  const who = Object.values(a.council.members).map((m) => `${shortModel(m.model)} ${m.thinking}`).join(', ');
  return `**Decided by the council** (both members chose this option independently; ${who}; class ${classes}; ${rev} to reverse). `
    + 'A later owner decision may overrule this one.';
}
