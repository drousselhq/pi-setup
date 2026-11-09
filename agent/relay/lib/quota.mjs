// pi-relay: Quota pacing for Anthropic subscription roles. Gates each worker step: waits for the 5h window to
// reset when it is nearly used, and keeps weekly usage at or below an even pace across the week (plus a margin).
// Pacing is a ceiling: unused days accumulate. Running steps are never interrupted.

import fs from 'node:fs';
import path from 'node:path';
import { C, callout, emit, event, log } from './console.mjs';
import { cfg, ctx, io, notify, RELAY_HOME, sleep } from './runtime.mjs';

export const WEEK_MS = 7 * 24 * 3600 * 1000;

export const usageFile = () => path.join(io.relayHome ?? RELAY_HOME, 'usage-cache.json');

export const usageCache = { at: 0, data: null, warnedAt: 0 };

export function loadSharedUsage() {
  try {
    const { at, data } = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    if (at > usageCache.at) Object.assign(usageCache, { at, data });
  } catch { /* no shared reading yet */ }
}

export const fetchUsageOnce = () => io.fetchUsage();

export function anthropicUsage() {
  loadSharedUsage();
  if (Date.now() - usageCache.at < 5 * 60 * 1000) return usageCache.data;
  let res = { status: 0 };
  for (const delay of [0, 20000, 60000, 120000]) {
    if (delay) sleep(delay);
    res = fetchUsageOnce();
    if (res.status === 200 && res.body) {
      Object.assign(usageCache, { at: Date.now(), data: res.body });
      emit('quota_reading', {
        fiveHour: res.body.five_hour?.utilization ?? null,
        sevenDay: res.body.seven_day?.utilization ?? null,
        sevenDayResetsAt: res.body.seven_day?.resets_at ?? null,
      });
      try { fs.writeFileSync(usageFile(), JSON.stringify({ at: usageCache.at, data: res.body })); } catch { /* cache is optional */ }
      return res.body;
    }
    loadSharedUsage(); // another relay may have succeeded meanwhile
    if (Date.now() - usageCache.at < 5 * 60 * 1000) return usageCache.data;
    if (res.status !== 429 && res.status !== 0) break; // retrying will not help
  }
  // Still unavailable: an hour-old reading is good enough for pacing; otherwise proceed and say so.
  if (usageCache.data && Date.now() - usageCache.at < 60 * 60 * 1000) return usageCache.data;
  if (Date.now() - usageCache.warnedAt > 60 * 60 * 1000) {
    usageCache.warnedAt = Date.now();
    log(`quota: usage unavailable after retries (HTTP ${res.status}); continuing without pacing until the next step`, { quiet: true });
    event(C.yellow('⚠'), `${C.yellow('quota')} ${C.dim(`usage unavailable (HTTP ${res.status}); continuing without pacing until the next step`)}`);
  }
  return null;
}

export function quotaWait(u) {
  const q = cfg.quota ?? {};
  const fiveMax = q.fiveHourMaxPercent ?? 90;
  const margin = q.weeklyPaceMarginPercent ?? 10;
  const t = Date.now();
  let wait = null;
  const consider = (until, why) => { if (until > t && (!wait || until > wait.until)) wait = { until, why }; };
  const five = u.five_hour;
  if (five?.utilization != null && five.utilization >= fiveMax && five.resets_at) {
    consider(Date.parse(five.resets_at) + 60000, `5h window at ${Math.round(five.utilization)}%`);
  }
  for (const [key, w] of Object.entries(u)) {
    if (!key.startsWith('seven_day') || w?.utilization == null || !w.resets_at) continue;
    const reset = Date.parse(w.resets_at);
    const start = reset - WEEK_MS;
    const allowed = Math.min(100, ((t - start) / WEEK_MS) * 100 + margin);
    if (w.utilization > allowed) {
      const catchUp = start + ((w.utilization - margin) / 100) * WEEK_MS;
      consider(Math.min(catchUp, reset + 60000), `${key} at ${Math.round(w.utilization)}%, ahead of the weekly pace (${Math.round(allowed)}% allowed now)`);
    }
  }
  return wait;
}

// Returns true if it had to wait.
export function quotaGate(role) {
  if (cfg.quota?.enabled === false || !String(cfg.roles?.[role]?.model ?? '').startsWith('anthropic/')) return false;
  let waited = false;
  let pauseStart = 0;
  for (;;) {
    const u = anthropicUsage();
    const w = u && quotaWait(u);
    if (!w) {
      if (waited) emit('quota_pause_end', { role, waitedMs: Date.now() - pauseStart });
      return waited;
    }
    if (!waited) {
      pauseStart = Date.now();
      emit('quota_pause', { role, until: new Date(w.until).toISOString(), reason: w.why });
      const when = new Date(w.until).toLocaleString();
      log(`quota: pausing before the next ${role} step until ${when}: ${w.why}`, { quiet: true });
      callout(C.yellow, 'Paused for quota', [w.why, `Resumes around ${when}, before the next ${role} step.`]);
      notify(`Relay ${ctx.topic} paused for quota`, `${w.why}. Resumes around ${when}.`);
    }
    waited = true;
    sleep(Math.min(w.until - Date.now(), 15 * 60 * 1000));
    usageCache.at = 0; // re-read after sleeping
  }
}
