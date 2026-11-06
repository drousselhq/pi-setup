// pi-relay: Worker agents in Herdr tabs: naming, starting, resuming and closing.

import { createHash } from 'node:crypto';
import { C, emit, event, live, log, roleTag, shortModel } from './console.mjs';
import { cfg, ctx, herdr, RelayStop, sleep, state } from './runtime.mjs';
import { save } from './store.mjs';

export function agentAlive(a) {
  const r = herdr(['agent', 'get', a.name], { allowFail: true });
  return r.error ? null : r.agent;
}

// Herdr agent names are unique per Herdr session and limited to 32 characters. Two relays may run the
// same topic name in different projects, so every name carries a short hash of the project and topic;
// the topic slug fills the remaining room.
export const AGENT_NAME_MAX = 32;

export function agentName(role, seq) {
  const suffix = `-${role}-${seq}`;
  const hash = createHash('sha1').update(`${ctx.project}\n${ctx.topic}`).digest('hex').slice(0, 4);
  const room = AGENT_NAME_MAX - suffix.length - hash.length - 1;
  const head = ctx.slug.slice(0, Math.max(1, room)).replace(/-+$/, '');
  return `${/^[a-z]/.test(head) ? head : `r${head}`.slice(0, Math.max(1, room))}-${hash}${suffix}`;
}

// A worker is recorded as `starting` before its tab and agent exist, so a relay interrupted while starting it
// (Ctrl-C) never reuses its name, and the next run closes what it left (see ensureAgent). Only a tab created
// in the moment before it is recorded can be left behind, as an empty shell.
export function startAgent(role, resumeSession) {
  const rc = cfg.roles?.[role];
  if (!rc?.model) throw new RelayStop(`No model configured for role ${role} (config.json roles.${role}).`);
  const seq = String(++state.seq).padStart(3, '0');
  const label = `${ctx.topic} ${state.cur.slice} ${role}`;
  const name = agentName(role, seq);
  const agent = { name, role, label, tab: null, session: resumeSession ?? null, starting: true };
  state.cur.agents[role] = agent;
  save();
  const tab = herdr(['tab', 'create', '--workspace', ctx.workspace, '--cwd', ctx.project, '--label', label, '--no-focus']);
  agent.tab = tab.tab.tab_id;
  save();
  const piArgs = ['--model', rc.model, '--thinking', rc.thinking ?? 'medium', '--name', label];
  if (resumeSession) piArgs.push('--session', resumeSession);
  let res;
  for (let i = 0; i < 30; i++) {
    res = herdr(['agent', 'start', name, '--kind', 'pi', '--pane', tab.root_pane.pane_id, '--', ...piArgs], { allowFail: true });
    if (res.error?.code !== 'agent_pane_busy') break;
    sleep(1000); // the new shell is not ready yet
  }
  if (res.error) {
    herdr(['tab', 'close', agent.tab], { allowFail: true });
    delete agent.starting; // nothing is left to close; the next start resumes the same session, if any
    agent.tab = null;
    throw new Error(`Could not start ${role}: ${res.error.code}: ${res.error.message}`);
  }
  agent.session = res.agent.agent_session?.value ?? null;
  delete agent.starting;
  state.sessions.push({ slice: state.cur.slice, role, name, session: agent.session, model: rc.model, thinking: rc.thinking });
  save();
  emit('agent_start', { role, agent: name, model: rc.model, thinking: rc.thinking ?? 'medium', session: agent.session, tab: agent.tab, resumedSession: Boolean(resumeSession) });
  log(`${state.cur.slice} started ${role} (${rc.model} ${rc.thinking ?? 'medium'}) in tab "${label}"${resumeSession ? ' resuming its session' : ''}`, { quiet: true });
  event(C.gray('▸'), `${roleTag(role)} ${C.dim(`started · ${shortModel(rc.model)} ${rc.thinking ?? 'medium'}${resumeSession ? ' · resumed session' : ''} · tab "${label}"`)}`);
  return agent;
}

export function ensureAgent(role) {
  const a = state.cur.agents[role];
  if (a?.starting) closeUnstarted(a);
  else if (a && agentAlive(a)) return { agent: a, fresh: false };
  return { agent: startAgent(role, a?.session), fresh: !a?.session };
}

// A worker whose start was interrupted: close its tab (with whatever started in it) and start anew.
function closeUnstarted(a) {
  if (a.tab) herdr(['tab', 'close', a.tab], { allowFail: true });
  emit('agent_start_recovered', { role: a.role, agent: a.name, tab: a.tab });
  log(`${state.cur.slice} closed ${a.role} ${a.name}, whose start was interrupted`, { quiet: true });
  delete a.starting; // closed once: a copy of this record restored later (a set-aside slice) is not closed again
  a.tab = null;
}

export function closeAgent(role) {
  const a = state.cur.agents[role];
  if (!a) return;
  const unstarted = Boolean(a.starting);
  if (unstarted) closeUnstarted(a);
  const live = !unstarted && agentAlive(a);
  if (live && live.agent_status === 'working') {
    herdr(['agent', 'wait', a.name, '--until', 'idle', '--until', 'done'], { allowFail: true });
  }
  if (live) herdr(['tab', 'close', a.tab], { allowFail: true });
  delete state.cur.agents[role];
  save();
}

export function closeAll() {
  for (const role of Object.keys(state.cur?.agents ?? {})) closeAgent(role);
}

// ---------- assignments and messages ----------
