// pi-relay: Waiting on workers: prompting them, settling, permission prompts, the compaction limit, and
// waiting for the owner to answer a worker in its tab.

import fs from 'node:fs';
import { agentAlive } from './agents.mjs';
import { C, callout, clearLive, compactionText, emit, event, fmtDuration, hhmm, live, log, roleTag } from './console.mjs';
import { cfg, ctx, herdr, HUMAN_STATUSES, notify, plural, RelayStop, sleep, state } from './runtime.mjs';
import { readResult } from './steps.mjs';
import { save } from './store.mjs';
import { sessionTotals, stepUsage } from './usage.mjs';

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

// Turns the agent's session has recorded so far: whether it worked since a prompt.
export const agentTurns = (agent) => sessionTotals(agent.session)?.turns ?? 0;

// Prompts at least once without typing the prompt twice. holder[key] records the attempt (agent, its turns,
// the text, the result file it asks for) before the prompt and is cleared once Herdr accepted it.
// resumePrompt() finishes an attempt a killed relay left: if the result file was written since, or the same
// agent has worked since, it was received; the same agent that has not may hold it unsent in its input box
// (Enter); otherwise it is sent again.
export function promptOnce(agent, holder, key, text, expect) {
  holder[key] = { agent: agent.name, turns: agentTurns(agent), text, expect, at: Date.now() };
  save();
  const status = prompt(agent, text);
  holder[key] = null;
  save();
  return status;
}

export function resumePrompt(agent, holder, key) {
  const was = holder[key];
  if (!was) return null;
  if (wroteSince(was.expect, was.at)) { holder[key] = null; save(); return 'idle'; }
  if (was.agent === agent.name) {
    const status = agentTurns(agent) > was.turns ? 'working' : submitPendingInput(agent);
    if (status) { holder[key] = null; save(); return status; }
  }
  return promptOnce(agent, holder, key, was.text, was.expect);
}

// Written after the attempt (no tolerance: the file it asks for may hold the worker's earlier result).
export const wroteSince = (file, at) => Boolean(file) && fs.existsSync(file) && fs.statSync(file).mtimeMs >= at;

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

export function showQuestion(agent, r) {
  log(`${state.cur.slice} ${agent.role} ${r.status}: ${r.question ?? r.summary ?? ''}`, { quiet: true });
  notify(`Relay ${ctx.topic}: ${agent.role} ${r.status}`, `${r.question ?? r.summary ?? ''}\nAnswer in tab "${agent.label}".`);
  const color = r.status === 'blocked' ? C.red : C.magenta;
  callout(color, `${agent.role} ${r.status === 'blocked' ? 'is blocked' : 'needs a decision'} \u2014 waiting for you`, [
    r.question ?? r.summary ?? '',
    C.dim(`Answer in tab "${agent.label}". The relay resumes when the ${agent.role} rewrites its result file.`),
    C.dim(`If only a new session can continue, stop the relay (Ctrl-C) and run: pi-relay ${ctx.topic} --fresh ${agent.role}`),
  ]);
}

// Wait for the operator to answer a worker in its own tab. Once the worker is working on the answer,
// show the live line and apply the compaction limit, exactly as for any other step. Returns the
// worker's next non-question result, or null when the step was interrupted as a runaway. With `decisions`,
// a new needs-decision result is returned too, for the caller to route to the advisor.
export function waitForOperator(agent, r, { show = showQuestion, track = true, decisions = false } = {}) {
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
      if (!HUMAN_STATUSES.has(next.status) || (decisions && next.status === 'needs-decision')) {
        clearLive();
        log(`${state.cur.slice} ${agent.role} ${next.status === 'needs-decision' ? 'asked for a decision' : 'finished'} after operator input`, { quiet: true });
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
