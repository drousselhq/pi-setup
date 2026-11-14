// Scorecard: recorded cost (every session read once, up to the cutoff), step-level cost shares, and quota.

import { addCost, readSession, zeroCost } from './records.mjs';

const CHECKING = new Set(['reviewer', 'acceptance', 'advisor', 'council']);
const roleOf = (role) => (/^council/.test(role) ? 'council' : role);

// Attributes each session to its slice (or to planning, the final verification or "none") and its role.
export function addCosts(result, { cutoffMs = Infinity, readSessionFile = readSession } = {}) {
  const { topic, slices, special } = result;
  const bySlice = new Map([...slices, ...special.values()].map((s) => [s.id, s]));
  const cost = { total: zeroCost(), byRole: {}, byModel: {}, outside: {}, bySession: {}, missing: 0, unreadable: 0, entries: [] };
  for (const s of bySlice.values()) { s.cost = zeroCost(); s.supersededUsd = 0; }
  for (const [key, info] of topic.sessions) {
    const s = bySlice.get(info.slice);
    const r = info.path ? readSessionFile(info.path, cutoffMs) : { missing: 'no session recorded' };
    if (r.missing) {
      cost.missing++;
      if (s && info.path) s.partial.push(`${info.role}: ${r.missing}`);
      continue;
    }
    if (r.unreadable) { cost.unreadable++; if (s) s.partial.push(`${info.role}: ${r.unreadable} unreadable session lines`); }
    addCost(cost.total, r.total);
    cost.bySession[key] = r.total.costUsd;
    addCost(cost.byRole[roleOf(info.role)] ??= zeroCost(), r.total);
    for (const [m, c] of Object.entries(r.byModel)) addCost(cost.byModel[m] ??= zeroCost(), c);
    for (const en of r.entries) cost.entries.push(en);
    if (s && !special.has(s.id)) {
      addCost(s.cost, r.total);
      if (s.startAt !== null && info.at < s.startAt) s.supersededUsd += r.total.costUsd; // an earlier attempt's session
    } else {
      addCost(cost.outside[info.slice ?? 'none'] ??= zeroCost(), r.total);
      if (s) addCost(s.cost, r.total);
    }
  }
  topic.cost = cost;
  return result;
}

// From the step results' own usage (which omits cache warming): everything after the slice's first rejection,
// and the steps a nudge interrupted.
export function stepShares(s) {
  const i = s.steps.findIndex((st) => st.role === 'reviewer' && st.verdict === 'changes-required');
  const usd = (list) => list.reduce((n, st) => n + (st.usage?.costUsd ?? 0), 0);
  return { reviewCycleUsd: i < 0 ? 0 : usd(s.steps.slice(i + 1)), nudgedUsd: usd(s.steps.filter((st) => st.nudged)) };
}

export function checkingUsd(topic) {
  return Object.entries(topic.cost.byRole).filter(([r]) => CHECKING.has(r)).reduce((n, [, c]) => n + c.costUsd, 0);
}

// Observed account quota change: positive steps within one reset window; a drop or a new reset time starts a
// new window. What happened between two windows is not observed. `byDay` keys are UTC dates.
export function quotaChange(readings) {
  let points = 0;
  let windows = 0;
  const byDay = {};
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const prev = readings[i - 1];
    if (!prev || prev.resets !== r.resets || r.pct < prev.pct) { windows++; continue; }
    points += r.pct - prev.pct;
    const day = new Date(r.at).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + r.pct - prev.pct;
  }
  return { points, windows, readings: readings.length, byDay };
}
