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

export function startAgent(role, resumeSession) {
  const rc = cfg.roles?.[role];
  if (!rc?.model) throw new RelayStop(`No model configured for role ${role} (config.json roles.${role}).`);
  const seq = String(++state.seq).padStart(3, '0');
  const label = `${ctx.topic} ${state.cur.slice} ${role}`;
  const name = agentName(role, seq);
  const tab = herdr(['tab', 'create', '--workspace', ctx.workspace, '--cwd', ctx.project, '--label', label, '--no-focus']);
  const piArgs = ['--model', rc.model, '--thinking', rc.thinking ?? 'medium', '--name', label];
  if (resumeSession) piArgs.push('--session', resumeSession);
  let res;
  for (let i = 0; i < 30; i++) {
    res = herdr(['agent', 'start', name, '--kind', 'pi', '--pane', tab.root_pane.pane_id, '--', ...piArgs], { allowFail: true });
    if (res.error?.code !== 'agent_pane_busy') break;
    sleep(1000); // the new shell is not ready yet
  }
  if (res.error) {
    herdr(['tab', 'close', tab.tab.tab_id], { allowFail: true });
    throw new Error(`Could not start ${role}: ${res.error.code}: ${res.error.message}`);
  }
  const agent = { name, role, label, tab: tab.tab.tab_id, session: res.agent.agent_session?.value ?? null };
  state.cur.agents[role] = agent;
  state.sessions.push({ slice: state.cur.slice, role, name, session: agent.session, model: rc.model, thinking: rc.thinking });
  save();
  emit('agent_start', { role, agent: name, model: rc.model, thinking: rc.thinking ?? 'medium', session: agent.session, tab: agent.tab, resumedSession: Boolean(resumeSession) });
  log(`${state.cur.slice} started ${role} (${rc.model} ${rc.thinking ?? 'medium'}) in tab "${label}"${resumeSession ? ' resuming its session' : ''}`, { quiet: true });
  event(C.gray('▸'), `${roleTag(role)} ${C.dim(`started · ${shortModel(rc.model)} ${rc.thinking ?? 'medium'}${resumeSession ? ' · resumed session' : ''} · tab "${label}"`)}`);
  return agent;
}

export function ensureAgent(role) {
  const a = state.cur.agents[role];
  if (a && agentAlive(a)) return { agent: a, fresh: false };
  return { agent: startAgent(role, a?.session), fresh: !a?.session };
}

export function closeAgent(role) {
  const a = state.cur.agents[role];
  if (!a) return;
  const live = agentAlive(a);
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
