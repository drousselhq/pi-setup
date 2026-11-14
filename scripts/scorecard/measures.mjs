// Scorecard: one pass over a topic's events, into per-slice records (the definitions are in EVALUATION.md).
// Unknown stays unknown: a field missing from older records is never counted as zero.

export const SPECIAL = new Set(['PLAN', 'FINAL']);
const ms = (t) => Date.parse(t);
// Field equality regardless of key order, for the replay rule.
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const resultKey = (e) => JSON.stringify(canon(Object.fromEntries(Object.entries(e).filter(([k]) => !['t', 'run', 'durationMs'].includes(k)))));

function newSlice(id) {
  return {
    id, title: null, starts: 0, startAt: null, firstAt: null, doneAt: null, asides: [], asideFrom: null, commits: null,
    base: null, head: null, sessions: [], partial: [], roles: new Set(), agents: new Set(), sentAgent: {}, steps: [],
    sentSinceResult: true, ambiguous: 0,
    pendingNudges: new Set(), loops: 0, firstReview: undefined, blockingSeen: new Set(), returning: new Set(),
    escalations: 0, nudges: {}, runaways: 0, acceptanceStep: false, acceptanceChanged: new Set(), ownerDecisions: 0,
    chosenKnown: 0, chosenRecommended: 0, councilDecisions: 0, councilReturned: 0,
    revisits: { known: 0, proposed: 0, owner: 0, council: 0 }, waits: {}, waitedByStatus: {}, untimedWaits: 0,
    pausedMs: 0, untimedPauses: 0, gapMs: 0, versions: new Set(), plan: null, verifications: [], finalFindings: 0,
  };
}

export function analyzeTopic(name, events) {
  const slices = new Map();
  const special = new Map();
  const CREATE = new Set(['slice_start', 'slice_done', 'agent_start', 'step_result']);
  const get = (id, type) => {
    if (!id) return null;
    const map = SPECIAL.has(id) ? special : slices;
    if (!map.has(id) && !CREATE.has(type)) return null; // an old event carrying a title as its slice: no new slice
    if (!map.has(id)) map.set(id, newSlice(id));
    return map.get(id);
  };
  const topic = {
    name, runs: [], stops: {}, planStops: 0, nudges: {}, quota: [], waitsByStatus: {}, sessions: new Map(),
    cutoffMs: events.length ? ms(events.at(-1).t) : null, ownerDecisions: 0, chosenKnown: 0, chosenRecommended: 0,
    councilDecisions: 0, councilReturned: 0, waitedMs: 0, untimedWaits: 0, completions: [],
  };
  const openWaits = new Map(); // run + role -> { at, s, status }
  const openPauses = new Map();
  const runStop = new Map();
  for (const e of events) if (e.type === 'run_stop') runStop.set(e.run, ms(e.t));
  let advisor = null; // the slice of the question being decided, and whether its brief proposed a revisit
  let lastEvent = null;

  for (const e of events) {
    const at = ms(e.t);
    const s = get(e.slice ?? null, e.type);
    if (s && s.firstAt === null) s.firstAt = at;
    switch (e.type) {
      case 'run_start':
        // The gap since the previous run's last event: unclassified (workers may have gone on working).
        if (s && lastEvent && lastEvent.run !== e.run && lastEvent.slice === e.slice) s.gapMs += at - ms(lastEvent.t);
        topic.runs.push({ run: e.run, at, roles: e.roles ?? null, setup: e.setup });
        if (s && e.setup !== undefined) s.versions.add(e.setup?.commit ?? 'none');
        break;
      case 'slice_start':
        s.starts++; s.startAt = at; s.title = e.title; s.base = e.base ?? s.base;
        if (e.needs?.includes('acceptance')) s.acceptanceStep = true;
        if (e.plan) s.plan = e.plan;
        break;
      case 'slice_set_aside': if (s) s.asideFrom = at; break;
      case 'slice_resumed': if (s && s.asideFrom !== null) { s.asides.push([s.asideFrom, at]); s.asideFrom = null; } break;
      case 'slice_done':
        s.doneAt = at; s.commits = Array.isArray(e.commits) ? e.commits.length : null; s.head = e.head ?? null;
        s.base = e.base ?? s.base;
        if (!s.starts) s.partial.push('history starts mid-slice');
        break;
      case 'agent_start':
        topic.sessions.set(e.session ?? `missing:${topic.sessions.size}`, { slice: e.slice ?? null, role: e.role, path: e.session ?? null, at });
        if (!s) break;
        s.roles.add(e.role);
        if (e.agent) s.agents.add(e.agent);
        if (!e.session) s.partial.push(`${e.role}: no session recorded`);
        if (e.setup !== undefined && !e.resumedSession) s.versions.add(e.setup?.commit ?? 'none');
        if (e.role === 'acceptance') s.acceptanceStep = true;
        break;
      case 'step_sent': if (s) { s.sentSinceResult = true; if (e.agent) s.sentAgent[e.role] = e.agent; } break;
      case 'step_result': {
        const key = resultKey(e);
        const prev = s.steps.at(-1);
        if (!s.sentSinceResult && prev) {
          if (prev.key === key) break; // a replayed result, recorded twice
          if (prev.role === e.role && prev.purpose === e.purpose) s.ambiguous++;
        }
        s.sentSinceResult = false;
        // The worker the step was sent to must have its start on record (a later worker of the same role too).
        const agent = s.sentAgent[e.role];
        if (!s.roles.has(e.role) || (agent && !s.agents.has(agent))) s.partial.push(`${e.role}: result without its session on record`);
        const nudged = s.pendingNudges.delete(`${e.role} ${e.purpose}`);
        s.steps.push({ key, role: e.role, purpose: e.purpose, verdict: e.verdict, usage: e.usage ?? null, nudged });
        if (e.status === 'runaway') s.runaways++;
        if (e.purpose === 'final' || e.purpose === 'verify') s.verifications.push(e.verification ?? null);
        if (e.role === 'reviewer' && e.blocking?.length && SPECIAL.has(s.id)) s.finalFindings++;
        if (e.role !== 'reviewer' || (e.verdict !== 'accept' && e.verdict !== 'changes-required')) break;
        // The first review is known only when the slice's start is on record and this is its first review.
        if (s.firstReview === undefined) s.firstReview = s.starts && e.purpose === 'review' ? e.verdict : null;
        if (e.verdict === 'changes-required') s.loops++;
        for (const b of e.blocking ?? []) {
          if (s.blockingSeen.has(b) && /^rereview/.test(e.purpose ?? '')) s.returning.add(b);
          s.blockingSeen.add(b);
        }
        break;
      }
      case 'escalation': if (s) s.escalations++; break;
      case 'nudge':
        topic.nudges[e.reason] = (topic.nudges[e.reason] ?? 0) + 1;
        if (s) { s.nudges[e.reason] = (s.nudges[e.reason] ?? 0) + 1; s.pendingNudges.add(`${e.role} ${e.purpose}`); }
        break;
      case 'acceptance_recorded': if (s) s.acceptanceStep = true; break;
      case 'acceptance_compared':
        if (s) for (const f of [...(e.changed ?? []), ...(e.missing ?? [])]) s.acceptanceChanged.add(f);
        break;
      case 'advisor_start': advisor = { s: get(e.slice, 'agent_start'), revisit: false }; break;
      case 'advisor_brief':
        if (advisor?.s && Array.isArray(e.revisits)) {
          advisor.s.revisits.known++;
          if (e.revisits.length) { advisor.s.revisits.proposed++; advisor.revisit = true; }
        }
        break;
      case 'owner_decision':
      case 'council_decision': {
        const owner = e.type === 'owner_decision';
        const target = advisor?.s ?? null; // the question this decision answers; old events lost their slice
        topic[owner ? 'ownerDecisions' : 'councilDecisions']++;
        if (target) target[owner ? 'ownerDecisions' : 'councilDecisions']++;
        if (advisor?.revisit && target) { target.revisits[owner ? 'owner' : 'council']++; advisor.revisit = false; }
        if (owner && Number.isInteger(e.chosen)) {
          topic.chosenKnown++; if (e.chosen === 1) topic.chosenRecommended++;
          if (target) { target.chosenKnown++; if (e.chosen === 1) target.chosenRecommended++; }
        }
        break;
      }
      case 'council_escalation': topic.councilReturned++; if (s) s.councilReturned++; break;
      case 'operator_wait_start':
        openWaits.set(`${e.run} ${e.role}`, { at, s, status: e.status ?? 'unknown' });
        topic.waitsByStatus[e.status] = (topic.waitsByStatus[e.status] ?? 0) + 1;
        if (s) s.waits[e.status] = (s.waits[e.status] ?? 0) + 1;
        break;
      case 'operator_wait_end': {
        const w = openWaits.get(`${e.run} ${e.role}`);
        addWait(topic, w?.s ?? s, w?.status ?? 'unknown', Number(e.waitedMs) || 0);
        openWaits.delete(`${e.run} ${e.role}`);
        break;
      }
      case 'quota_pause': openPauses.set(`${e.run} ${e.role}`, { at, s }); break;
      case 'quota_pause_end':
        if (s) s.pausedMs += Number(e.waitedMs) || 0;
        openPauses.delete(`${e.run} ${e.role}`);
        break;
      case 'run_stop':
        topic.stops[e.kind ?? 'stop'] = (topic.stops[e.kind ?? 'stop'] ?? 0) + 1;
        if (/plan\.md/.test(e.reason ?? '')) topic.planStops++;
        break;
      case 'run_complete': topic.completions.push(e.verification ?? null); break;
      case 'quota_reading':
        if (Number.isFinite(e.sevenDay)) topic.quota.push({ at, pct: e.sevenDay, resets: Math.round(ms(e.sevenDayResetsAt) / 60000) });
        break;
      default: break;
    }
    lastEvent = e;
  }
  // Open waits and pauses: closed at their run's recorded stop, as the console does; otherwise untimed.
  for (const [key, w] of openWaits) {
    const stop = runStop.get(key.slice(0, key.indexOf(' ')));
    if (stop === undefined) { topic.untimedWaits++; if (w.s) w.s.untimedWaits++; } else addWait(topic, w.s, w.status, Math.max(0, stop - w.at));
  }
  for (const [key, p] of openPauses) {
    const stop = runStop.get(key.slice(0, key.indexOf(' ')));
    if (!p.s) continue;
    if (stop === undefined) p.s.untimedPauses++; else p.s.pausedMs += Math.max(0, stop - p.at);
  }
  return { topic, slices: [...slices.values()], special };
}

function addWait(topic, s, status, w) {
  topic.waitedMs += w;
  if (s) s.waitedByStatus[status] = (s.waitedByStatus[status] ?? 0) + w;
}

// Latency of a finished slice: from its last start, without the set-aside time inside that interval.
export function latency(s) {
  if (s.doneAt === null || s.startAt === null) return null;
  const aside = s.asides.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, s.doneAt) - Math.max(a, s.startAt)), 0);
  return s.doneAt - s.startAt - aside;
}

export const waited = (s) => Object.values(s.waitedByStatus).reduce((n, x) => n + x, 0);
