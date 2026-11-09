// pi-relay: Waiting on workers: prompting them, settling, permission prompts, the compaction limit, and
// waiting for the owner to answer a worker in its tab.

import fs from 'node:fs';
import path from 'node:path';
import { appendToDecisions } from './advisor.mjs';
import { agentAlive } from './agents.mjs';
import { C, callout, clearLive, compactionText, emit, event, fmtDuration, hhmm, live, log, roleTag } from './console.mjs';
import { compactionLimit, ctx, herdr, HUMAN_STATUSES, io, notify, plural, RelayStop, sleep, state } from './runtime.mjs';
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
      const { at, screen } = permissionNotice(agent);
      herdr(['agent', 'wait', agent.name, '--until', 'working', '--until', 'idle', '--until', 'done']);
      emit('permission_wait', { role: agent.role, waitedMs: Date.now() - at, screen });
    }
    // Short waits so the console can show a live "working for 12m" line in between.
    const r = herdr(['agent', 'wait', agent.name, '--timeout', '10000'], { allowFail: true });
    if (r.error?.code === 'timeout') {
      // Step usage and the compaction limit belong to the pending step's worker, not to a helper
      // such as the advisor that may be working while that step waits.
      const pending = state.cur?.pending;
      const p = pending && pending.role === agent.role ? pending : null;
      const u = p ? stepUsage(p) : null;
      const limit = compactionLimit();
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

// A worker or council member waiting on a permission prompt: its screen excerpt in the log and the console, and a
// notification.
export function permissionNotice(agent) {
  const screen = screenExcerpt(agent);
  log(`${state.cur.slice} ${agent.role} is waiting on a prompt in tab "${agent.label}"${screen ? `; screen: ${screen.replace(/\s+/g, ' ')}` : ''}`, { quiet: true });
  callout(C.magenta, `${agent.role} is waiting on a prompt`, [`Answer it in tab "${agent.label}". The relay continues by itself.`,
    ...(screen ? [C.dim('Its screen (an excerpt):'), ...screen.split('\n').map((l) => C.dim(l))] : [])]);
  notify(`Relay ${ctx.topic}: ${agent.role} needs you`, `Answer the prompt in tab "${agent.label}".`);
  return { at: Date.now(), screen };
}

// The last lines of an agent's screen (a permission prompt, typically), trimmed; null when Herdr cannot read it.
// A screen excerpt, not the prompt's exact text.
export function screenExcerpt(agent, lines = 15) {
  const r = io.herdr(['agent', 'read', agent.name, '--source', 'recent-unwrapped', '--lines', String(lines)]);
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const text = r.stdout.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n').slice(-1200);
  return text || null;
}

// ---------- answers typed in a worker's tab ----------
// Each wait of a worker for the owner in its own tab is a window: what was typed into its session between the
// question and the worker's next result is recorded in decisions.md, once, as an unverified excerpt (Pi does not
// record who typed a message). The window is opened (offset, start time) when the wait starts, and its end is saved
// when the next result appears, before anything is sent to the worker; recordTabAnswer() then appends it.

export function openTabWindow(p, r, session, waitStart) {
  const workerAsked = !r.relayMade && r._path && r._mtime;
  const key = workerAsked ? `${path.basename(r._path)}@${r._mtime}` : `relay@${waitStart}`;
  if (p.tabAnswer?.key === key) return; // the same wait, resumed after a restart
  p.tabWindows = (p.tabWindows ?? 0) + 1;
  p.tabAnswer = {
    key, id: `${path.basename(p.resultPath)}#${p.tabWindows}`, role: p.role, session, recorded: false, to: null,
    relayMade: !workerAsked,
    question: workerAsked ? (r.question ?? r.summary ?? '') : `asked by the relay: ${r.question}`,
    from: workerAsked ? r._mtime : waitStart, offset: session && fs.existsSync(session) ? fs.statSync(session).size : 0,
  };
  save();
}

export function closeTabWindow(p, end) {
  if (!p.tabAnswer || p.tabAnswer.to) return;
  p.tabAnswer.to = end;
  save();
  recordTabAnswer(p);
}

// Appends a closed window's excerpt to decisions.md once (its heading names it); also run on a resumed step.
export function recordTabAnswer(p) {
  const t = p.tabAnswer;
  if (!t?.to || t.recorded) return;
  const { excerpt, readable } = tabExcerpt(t);
  if (!excerpt && readable && t.relayMade) { t.recorded = true; save(); return; } // nothing typed during the relay's own wait
  const heading = `## Tab answer · ${new Date(t.to).toISOString().slice(0, 10)} · ${state.cur.slice} · ${t.role} · ${t.id}`;
  appendToDecisions(new RegExp(`^## Tab answer · .* · ${t.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${heading}\n\n`
    + `Question: ${String(t.question).replace(/\s+/g, ' ').trim()}\n\n`
    + `Typed in the ${t.role}'s tab while it waited (an unverified excerpt of its session, not a decision brief: Pi does not `
    + 'record who typed a message):\n\n'
    + (excerpt ? excerpt.split('\n').map((l) => `> ${l}`).join('\n') : '> (answer not readable; see the tab)') + '\n');
  t.recorded = true;
  save();
}

// The user-role text typed into a session within a window: read from the saved offset (at most 1 MB, from the
// first full line), entries timestamped from the window's start to its end (a second either side, for clock
// granularity), text parts only, at most 2,000 characters. { excerpt, readable }: excerpt null with readable true
// when nothing was typed; readable false when the session cannot be read or branched there (two entries continuing
// the same one: which answer stands cannot be told).
function tabExcerpt(t) {
  const unreadable = { excerpt: null, readable: false };
  try {
    if (!t.session || !fs.existsSync(t.session)) return unreadable;
    const fd = fs.openSync(t.session, 'r');
    let text;
    const start = Math.max(0, t.offset - 1); // one byte early: whether the offset falls on a line start
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.max(0, Math.min(1 << 20, size - start)));
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = text.split('\n');
    if (start > 0) lines.shift(); // empty when the offset was a line start, else the end of a partial line
    const typed = [];
    const parents = new Set();
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.parentId) {
        if (parents.has(e.parentId)) return unreadable; // a branch
        parents.add(e.parentId);
      }
      const at = Date.parse(e?.timestamp);
      if (e?.type !== 'message' || e.message?.role !== 'user' || !(at >= t.from - 1000 && at <= t.to + 1000)) continue;
      const c = e.message.content;
      const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text) : [];
      typed.push(...parts.filter((x) => typeof x === 'string' && x.trim()));
    }
    const all = typed.join('\n').trim();
    return { excerpt: all ? (all.length > 2000 ? `${all.slice(0, 2000)} …` : all) : null, readable: true };
  } catch { return unreadable; }
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
export function waitForOperator(agent, r, { show = showQuestion, track = true, decisions = false, tab = null } = {}) {
  let waitStart = Date.now();
  let answered = false;
  let prompted = null; // a permission prompt being waited on: { at, screen }
  let blockedSamples = 0;
  if (tab) openTabWindow(tab, r, agent.session, waitStart); // `tab`: the worker's step (not the advisor's own wait)
  emit('operator_wait_start', { role: agent.role, status: r.status, question: r.brief?.question ?? r.question ?? r.summary ?? null });
  show(agent, r);
  for (;;) {
    sleep(10000);
    const liveAgent = agentAlive(agent);
    if (!liveAgent) throw new RelayStop(`The ${agent.role} tab was closed while waiting for an answer. Re-run pi-relay ${ctx.topic} to continue.`);
    const next = readResult(r._path, r._mtime + 1);
    if (next && next._mtime > r._mtime) {
      if (prompted) { // the prompt was answered and the worker finished in the same moment
        emit('permission_wait', { role: agent.role, waitedMs: Date.now() - prompted.at, screen: prompted.screen });
        prompted = null;
      }
      if (tab) closeTabWindow(tab, next._mtime);
      if (!answered) emit('operator_wait_end', { role: agent.role, waitedMs: Date.now() - waitStart });
      if (!HUMAN_STATUSES.has(next.status) || (decisions && next.status === 'needs-decision')) {
        clearLive();
        log(`${state.cur.slice} ${agent.role} ${next.status === 'needs-decision' ? 'asked for a decision' : 'finished'} after operator input`, { quiet: true });
        return next;
      }
      r = next; // it asks again
      answered = false;
      waitStart = Date.now();
      if (tab) openTabWindow(tab, r, agent.session, waitStart);
      emit('operator_wait_start', { role: agent.role, status: r.status, question: r.brief?.question ?? r.question ?? r.summary ?? null });
      show(agent, r);
      continue;
    }
    const p = state.cur.pending;
    const status = liveAgent.agent_status;
    // A permission prompt while it works on the answer: shown, notified and recorded as in settle(). Herdr can report
    // "blocked" for a moment while a tool starts: two samples in a row make it a prompt.
    blockedSamples = status === 'blocked' ? blockedSamples + 1 : 0;
    if (blockedSamples >= 2 && !prompted) prompted = permissionNotice(agent);
    if (status !== 'blocked' && prompted) {
      emit('permission_wait', { role: agent.role, waitedMs: Date.now() - prompted.at, screen: prompted.screen });
      prompted = null;
    }
    if ((status === 'working' || status === 'blocked') && !answered) {
      answered = true;
      emit('operator_wait_end', { role: agent.role, waitedMs: Date.now() - waitStart });
      log(`${state.cur.slice} ${agent.role} resumed after operator input`, { quiet: true });
      event(C.green('\u21b3'), `${roleTag(agent.role)} ${C.dim('working on your answer')}`);
    }
    if (!answered) continue;
    const u = track && p ? stepUsage(p) : null;
    const limit = compactionLimit();
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
