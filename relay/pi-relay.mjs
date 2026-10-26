#!/usr/bin/env node
// pi-relay: deterministic driver for plan → (scout/architect) → implement → review → repair.
// The script owns sequencing and state; Pi workers in Herdr tabs own all judgment.
// See README.md beside this file for file formats and usage.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_HOME = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const HUMAN_STATUSES = new Set(['needs-decision', 'blocked']);
const HELP_STATUSES = { 'needs-scout': 'scout', 'needs-architecture': 'architect' };
const TEMPLATE = { planner: 'plan', scout: 'scout', architect: 'architecture', implementer: 'implement', senior: 'implement', reviewer: 'review', advisor: 'advise' };
const STATUSES = {
  planner: ['done', 'needs-decision', 'blocked'],
  scout: ['done', 'needs-decision', 'blocked'],
  architect: ['done', 'needs-decision', 'blocked'],
  implementer: ['done', 'needs-scout', 'needs-architecture', 'needs-decision', 'blocked'],
  senior: ['done', 'needs-scout', 'needs-architecture', 'needs-decision', 'blocked'],
  advisor: ['needs-decision', 'done', 'blocked'],
  reviewer: ['done', 'needs-architecture', 'needs-decision', 'blocked'],
};

class RelayStop extends Error {}

// ---------- process helpers ----------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (r.error) throw r.error;
  return r;
}

function herdr(args, { allowFail = false } = {}) {
  const r = run('herdr', args);
  let json = null;
  for (const out of [r.stdout, r.stderr]) {
    try { json = JSON.parse(out); break; } catch { /* try the other stream */ }
  }
  if (json && !json.error) return json.result;
  const error = json?.error ?? { code: 'unparsed', message: (r.stderr || r.stdout).trim() };
  if (allowFail) return { error };
  throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${error.code}: ${error.message}`);
}

function git(args) {
  const r = run('git', args, { cwd: ctx.project });
  return r.status === 0 ? r.stdout.trim() : null;
}

function notify(title, body) {
  process.stdout.write('\x07');
  herdr(['notification', 'show', title, '--body', body, '--sound', 'request'], { allowFail: true });
  run('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
}

// ---------- console output ----------
// The console is for a human watching the run; relay/log.md keeps the same events as plain text.

const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  dim: sgr('2'), bold: sgr('1'), red: sgr('31'), green: sgr('32'), yellow: sgr('33'),
  magenta: sgr('35'), cyan: sgr('36'), gray: sgr('90'),
};
const ROLE_COLOR = {
  planner: sgr('38;5;213'), scout: sgr('38;5;180'), architect: sgr('38;5;80'),
  implementer: sgr('38;5;75'), senior: sgr('38;5;208'), reviewer: sgr('38;5;141'), advisor: sgr('38;5;220'),
};
const GUTTER = 11; // width of "  HH:MM  ✓ "
const hhmm = () => new Date().toTimeString().slice(0, 5);
// Read on every draw: the same run can be viewed on a laptop and on a phone (narrow terminal).
// The relay blocks in synchronous calls, so Node never processes SIGWINCH and process.stdout.columns
// goes stale after a resize; ask the terminal directly instead.
// process.stdout.getWindowSize() returns the same cached value, so read the terminal device through the
// TTY handle (a synchronous ioctl, as Node itself does on SIGWINCH).
function termColumns() {
  try {
    const handle = process.stdout.isTTY ? process.stdout._handle : null;
    if (handle?.getWindowSize) {
      const size = [0, 0];
      if (!handle.getWindowSize(size) && size[0] > 0) return size[0];
    }
  } catch { /* fall back below */ }
  return process.stdout.columns || 100;
}
const width = () => Math.max(20, Math.min(termColumns(), 110));
const narrow = () => width() < 60;
const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (text) => [...String(text).replace(ANSI, '')].length;

// Cut a coloured line to `max` visible characters (keeping colour codes intact), ending with an ellipsis.
function fitLine(text, max) {
  if (visibleLength(text) <= max) return text;
  let result = '';
  let n = 0;
  for (const part of String(text).split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { result += part; continue; }
    for (const ch of part) {
      if (n >= max - 1) return `${result}\u2026\x1b[0m`;
      result += ch;
      n++;
    }
  }
  return result;
}
const roleTag = (role) => (ROLE_COLOR[role] ?? C.bold)(role.padEnd(11));
const shortModel = (m) => String(m).split('/').pop().replace(/^claude-/, '');
let liveShown = false;
let liveLength = 0; // visible length of the live line currently on screen

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// If the terminal got narrower than the live line on screen, the terminal may have split that line
// over several rows; clearing only the last row would leave fragments, so move to a fresh line instead.
function leaveOrClearLive(cols) {
  if (!liveShown) return;
  process.stdout.write(liveLength > cols - 1 ? '\n' : '\r\x1b[2K');
  liveShown = false;
}

function clearLive() {
  leaveOrClearLive(termColumns());
}

// A single self-replacing status line (TTY only), e.g. while a worker is busy.
function live(text) {
  if (!TTY) return;
  // Must never wrap: a carriage return only reaches the start of the last physical line, so a wrapped
  // live line would leave a fragment behind on every update.
  const cols = termColumns();
  leaveOrClearLive(cols);
  const line = fitLine(text, cols - 2);
  process.stdout.write(`\r\x1b[2K${line}`);
  liveShown = true;
  liveLength = visibleLength(line);
}

function out(text = '') {
  clearLive();
  console.log(text);
}

// Word-wrap to the terminal width, measuring visible characters (colour codes excluded).
// `firstPrefix` lets an event's time and icon lead the first line, with `prefix` on continuations.
function wrap(text, indent, prefix = ' '.repeat(indent), firstPrefix = prefix) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const max = Math.max(10, width() - visibleLength(lines.length ? prefix : firstPrefix));
      if (line && visibleLength(line) + visibleLength(word) + 1 > max) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  // A prefix (e.g. a coloured bar) ends with a reset, so re-apply the style that was active where the
  // previous line broke; otherwise a wrapped grey paragraph turns white on its continuation lines.
  let carry = '';
  return lines.map((l, k) => {
    const styled = carry + l;
    carry = activeStyle(styled);
    return (k === 0 ? firstPrefix : prefix) + styled + (carry ? '\x1b[0m' : '');
  }).join('\n');
}

// Colour codes still in effect at the end of `text` (everything after its last reset).
function activeStyle(text) {
  const codes = String(text).match(/\x1b\[[0-9;]*m/g) ?? [];
  const lastReset = codes.lastIndexOf('\x1b[0m');
  return codes.slice(lastReset + 1).join('');
}

function event(icon, text, detail) {
  out(wrap(text, 0, ' '.repeat(narrow() ? 4 : GUTTER), `  ${C.gray(hhmm())}  ${icon} `));
  if (detail) out(C.dim(wrap(detail, narrow() ? 4 : GUTTER)));
}

function heading(title, right = '') {
  const w = width();
  out('');
  if (title.length + right.length + 10 > w) {
    // Narrow terminal: title on its own (cut if needed), progress on the next line.
    out(C.bold(fitLine(`\u2501\u2501 ${title}`, w - 1)));
    if (right) out(C.gray(`   ${right}`));
    return;
  }
  const fill = Math.max(3, w - title.length - right.length - 6);
  out(`${C.bold(`\u2501\u2501 ${title} `)}${C.gray('\u2501'.repeat(fill))}${right ? C.gray(` ${right}`) : ''}`);
}

function callout(color, title, lines) {
  const bar = color('  ┃ ');
  out('');
  out(wrap(C.bold(color(title)), 4, bar));
  for (const l of lines.filter(Boolean)) out(wrap(l, 4, bar));
  out('');
}

// Write a plain event to relay/log.md (and, unless `quiet`, a neutral console line).
function log(line, { quiet = false } = {}) {
  if (ctx.logFile) fs.appendFileSync(ctx.logFile, `- ${now()} ${line}\n`);
  if (!quiet) event(C.gray('·'), C.dim(line));
}

// Structured history for later evaluation: one JSON object per line in relay/events.jsonl.
// Plain log.md is for reading; this file is for analysis (durations, outcomes, token usage).
function emit(type, data = {}) {
  if (!ctx.relayDir) return;
  const entry = { t: new Date().toISOString(), run: RUN_ID, topic: ctx.topic, slice: state?.cur?.slice ?? null, type, ...data };
  try { fs.appendFileSync(path.join(ctx.relayDir, 'events.jsonl'), JSON.stringify(entry) + '\n'); } catch { /* history is best-effort */ }
}

// Token usage, cost and compactions from worker Pi session files. Files are read incrementally
// (only bytes added since the last read), so the live console line stays cheap even for huge sessions.
const zeroUsage = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, compactions: 0 });
const sessionCache = new Map(); // path -> { offset, carry: Buffer, totals }

function addSessionLine(totals, line) {
  if (!line.includes('"compaction"') && !line.includes('"usage"')) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'compaction') totals.compactions++;
  const m = e.message;
  if (e.type !== 'message' || m?.role !== 'assistant' || !m.usage) return;
  totals.turns++;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) totals[k] += m.usage[k] ?? 0;
  totals.costUsd += m.usage.cost?.total ?? 0;
}

function sessionTotals(file) {
  if (!file || !fs.existsSync(file)) return null;
  let c = sessionCache.get(file);
  const size = fs.statSync(file).size;
  if (!c || size < c.offset) { c = { offset: 0, carry: Buffer.alloc(0), totals: zeroUsage() }; sessionCache.set(file, c); }
  if (size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(Math.min(8 << 20, size - c.offset));
      while (c.offset < size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - c.offset), c.offset);
        if (n <= 0) break;
        c.offset += n;
        const buf = Buffer.concat([c.carry, chunk.subarray(0, n)]);
        const end = buf.lastIndexOf(10); // last newline: keep any partial line for next time
        if (end < 0) { c.carry = buf; continue; }
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) addSessionLine(c.totals, line);
        c.carry = Buffer.from(buf.subarray(end + 1));
      }
    } finally { fs.closeSync(fd); }
  }
  return { ...c.totals };
}

// Usage of the pending step so far: session totals now minus the totals when the step was sent.
function stepUsage(p) {
  const session = state.cur?.agents[p.role]?.session;
  const nowTotals = sessionTotals(session);
  if (!nowTotals) return null;
  const start = p.startUsage?.session === session ? p.startUsage.totals : null;
  const d = zeroUsage();
  for (const k of Object.keys(d)) d[k] = nowTotals[k] - (start?.[k] ?? 0);
  d.costUsd = Math.round(d.costUsd * 10000) / 10000;
  return d;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function compactionText(n) {
  const t = plural(n, 'compaction');
  return n >= 3 ? C.red(t) : n >= 1 ? C.yellow(t) : C.gray(t);
}

// Deterministic progress: slices and acceptance bullets of accepted slices, from plan.md and state.
function progress() {
  const slices = parsePlan();
  const done = slices.filter((x) => state.slices[x.id]?.status === 'done');
  const sum = (list) => list.reduce((n, x) => n + x.acceptance, 0);
  const finished = Object.values(state.slices);
  return {
    slices: slices.length, slicesDone: done.length,
    criteria: sum(slices), criteriaMet: sum(done),
    loops: finished.reduce((n, x) => n + (x.cycles ?? 0), 0) + (state.cur?.cycle ?? 0),
    compactions: finished.reduce((n, x) => n + (x.compactions ?? 0), 0) + (state.cur?.compactions ?? 0),
    index: (id) => slices.findIndex((x) => x.id === id) + 1,
  };
}

function progressText(pr) {
  return [
    `slices ${pr.slicesDone}/${pr.slices}`,
    pr.criteria ? `acceptance ${pr.criteriaMet}/${pr.criteria}` : null,
    plural(pr.loops, 'review loop'),
    plural(pr.compactions, 'compaction'),
  ].filter(Boolean).join(' \u00b7 ');
}

const PURPOSE = {
  plan: 'write the plan', prep: 'prepare the slice', implement: 'implement', final: 'final verification',
  review: 'review', help: 'answer a question',
};
function purposeLabel(p) {
  const m = String(p).match(/^(repair|rereview)(\d+)$/);
  if (m) return `${m[1] === 'repair' ? 'repair' : 're-review'} ${C.gray(`· cycle ${m[2]}`)}`;
  return PURPOSE[p] ?? p;
}

function resultIcon(r) {
  if (r.status === 'runaway') return C.red('\u25a0');
  if (r.status === 'done') return r.verdict === 'changes-required' ? C.yellow('↻') : C.green('✓');
  if (r.status === 'blocked') return C.red('✗');
  return C.magenta('?');
}

function resultLabel(r) {
  if (r.status === 'runaway') return C.red('stopped (compaction limit)');
  if (r.verdict === 'accept') return C.green('accepted');
  if (r.verdict === 'changes-required') {
    const ids = Array.isArray(r.blocking) && r.blocking.length ? ` ${C.gray(`· blocking ${r.blocking.join(', ')}`)}` : '';
    return C.yellow('changes required') + ids;
  }
  if (r.status === 'done') return C.green('done');
  if (r.status === 'blocked') return C.red('blocked');
  return C.magenta(r.status.replace('-', ' '));
}

// ---------- quota pacing (Anthropic subscription) ----------
// Gates each worker step: waits for the 5h window to reset when it is nearly used, and keeps
// weekly usage at or below an even pace across the week (plus a margin). Pacing is a ceiling:
// unused days accumulate. Running steps are never interrupted.

const WEEK_MS = 7 * 24 * 3600 * 1000;
const USAGE_SNIPPET = `let t='';process.stdin.on('data',d=>t+=d).on('end',async()=>{try{
  const r=await fetch('https://api.anthropic.com/api/oauth/usage',{headers:{Authorization:'Bearer '+t.trim(),
    'anthropic-beta':'oauth-2025-04-20',Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({status:r.status,body:r.ok?await r.json():null}));
}catch(e){console.log(JSON.stringify({status:0,error:String(e)}))}});`;
// The usage endpoint is itself rate-limited (every Pi session's quota footer also polls it), so
// readings are shared across relays and restarts through a small file, and 429s are retried.
const USAGE_FILE = path.join(RELAY_HOME, 'usage-cache.json');
const usageCache = { at: 0, data: null, warnedAt: 0 };

function loadSharedUsage() {
  try {
    const { at, data } = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (at > usageCache.at) Object.assign(usageCache, { at, data });
  } catch { /* no shared reading yet */ }
}

function fetchUsageOnce() {
  const tok = run('pi', ['auth', 'print-bearer-token', '--provider', 'anthropic']);
  if (tok.status !== 0) return { status: 0 };
  const r = run(process.execPath, ['-e', USAGE_SNIPPET], { input: tok.stdout.trim() });
  try { return JSON.parse(r.stdout); } catch { return { status: 0 }; }
}

function anthropicUsage() {
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
      try { fs.writeFileSync(USAGE_FILE, JSON.stringify({ at: usageCache.at, data: res.body })); } catch { /* cache is optional */ }
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

function quotaWait(u) {
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
function quotaGate(role) {
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

// ---------- context, config, state ----------

const ctx = {};
let cfg;
let state;

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function setup(topic) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(topic) || topic === 'archives') {
    throw new RelayStop(`Invalid topic name: ${topic}`);
  }
  const top = run('git', ['rev-parse', '--show-toplevel']);
  ctx.project = top.status === 0 ? top.stdout.trim() : process.cwd();
  ctx.topic = topic;
  ctx.slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  ctx.topicDir = path.join(ctx.project, '.agents_work', topic);
  ctx.relayDir = path.join(ctx.topicDir, 'relay');
  ctx.handoff = path.join(ctx.topicDir, 'handoff.md');
  ctx.plan = path.join(ctx.topicDir, 'plan.md');
  ctx.decisions = path.join(ctx.topicDir, 'decisions.md');
  ctx.stateFile = path.join(ctx.relayDir, 'state.json');
  ctx.logFile = path.join(ctx.relayDir, 'log.md');
  if (!fs.existsSync(ctx.handoff) && !fs.existsSync(ctx.plan)) {
    throw new RelayStop(`Neither ${ctx.handoff} nor ${ctx.plan} exists. Write a handoff first (/handoff).`);
  }
  fs.mkdirSync(ctx.relayDir, { recursive: true });

  const global = readJson(path.join(RELAY_HOME, 'config.json'), {});
  const local = readJson(path.join(ctx.topicDir, 'relay.json'), {});
  cfg = { ...global, ...local, roles: { ...global.roles } };
  for (const [role, v] of Object.entries(local.roles ?? {})) cfg.roles[role] = { ...cfg.roles[role], ...v };

  state = readJson(ctx.stateFile, { seq: 0, slices: {}, cur: null, sessions: [] });
  if (state.startStatus === undefined) {
    state.startStatus = git(['status', '--porcelain']) ?? '';
    state.startHead = git(['rev-parse', 'HEAD']);
  }
}

function save() {
  const tmp = `${ctx.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, ctx.stateFile);
}

function acquireLock() {
  const lock = path.join(ctx.relayDir, 'lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); throw new RelayStop(`Another relay (pid ${pid}) is running this topic.`); }
    catch (e) { if (e instanceof RelayStop) throw e; }
  }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => {
    try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch { /* gone */ }
  });
}

// ---------- plan ----------

function parsePlan() {
  if (!fs.existsSync(ctx.plan)) return [];
  const slices = [];
  let cur = null;
  for (const line of fs.readFileSync(ctx.plan, 'utf8').split('\n')) {
    const m = line.match(/^##\s+(S\d+[a-z]?)\s*[:—–-]\s*(.+?)\s*$/i);
    if (m) {
      cur = { id: m[1].toUpperCase(), title: m[2], lines: [line], needs: [], acceptance: 0, inAcceptance: false };
      slices.push(cur);
    } else if (/^#{1,2}\s/.test(line)) {
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
      const n = line.match(/^\W*needs\W*:\s*(.+)$/i);
      if (n) cur.needs = n[1].toLowerCase().split(/[,\s]+/).filter((x) => x === 'scout' || x === 'architecture');
      // Acceptance criteria: the bullets under "Acceptance:" (or one inline criterion after the colon).
      const a = line.match(/^\W*acceptance\W*:\s*(.*)$/i);
      if (a) { cur.inAcceptance = true; if (a[1].trim()) cur.acceptance++; }
      else if (cur.inAcceptance && /^\s*([-*+]|\d+[.)])\s+\S/.test(line)) cur.acceptance++;
      else if (cur.inAcceptance && line.trim() && !/^\s{2,}\S/.test(line)) cur.inAcceptance = false;
    }
  }
  const ids = slices.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new RelayStop(`plan.md defines slice ${dup} twice.`);
  return slices.map(({ inAcceptance, ...s }) => ({ ...s, body: s.lines.join('\n').trim() }));
}

const RUN_ID = `${process.pid}-${Date.now()}`;
const PLAN_SLICE = { id: 'PLAN', title: 'Write the slice plan', body: '', needs: [] };
const FINAL_SLICE = {
  id: 'FINAL',
  title: 'Final verification',
  needs: [],
  body: 'Run the project\'s required full verification on the current candidate (all slices). '
    + 'Fix failures that belong to this work, within its accepted scope. Do not start new features.',
};

// ---------- agents ----------

function agentAlive(a) {
  const r = herdr(['agent', 'get', a.name], { allowFail: true });
  return r.error ? null : r.agent;
}

// Herdr agent names are limited to 32 characters. Keep the whole topic slug when it fits; otherwise
// shorten it and add a short hash of the topic, so two long topics with the same start stay distinct.
const AGENT_NAME_MAX = 32;
function agentName(role, seq) {
  const suffix = `-${role}-${seq}`;
  const room = AGENT_NAME_MAX - suffix.length;
  if (ctx.slug.length <= room) return `${ctx.slug}${suffix}`;
  const hash = createHash('sha1').update(ctx.topic).digest('hex').slice(0, 4);
  const head = ctx.slug.slice(0, Math.max(1, room - hash.length - 1)).replace(/-+$/, '');
  return `${head}-${hash}${suffix}`;
}

function startAgent(role, resumeSession) {
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

function ensureAgent(role) {
  const a = state.cur.agents[role];
  if (a && agentAlive(a)) return { agent: a, fresh: false };
  return { agent: startAgent(role, a?.session), fresh: !a?.session };
}

function closeAgent(role) {
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

function closeAll() {
  for (const role of Object.keys(state.cur?.agents ?? {})) closeAgent(role);
}

// ---------- assignments and messages ----------

function sliceDir(id) {
  const dir = path.join(ctx.topicDir, 'slices', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function artifactPath(role, sliceId) {
  if (role === 'planner') return ctx.plan;
  const file = { scout: 'scout.md', architect: 'architecture.md', implementer: 'implementation.md', senior: 'implementation.md', reviewer: 'review.md', advisor: 'advice.md' }[role];
  return path.join(sliceDir(sliceId), file);
}

function gitRules(role) {
  if (role !== 'implementer' && role !== 'senior') {
    return 'Do not edit product files (code, tests, configuration, docs). Write only your artifact and the result file. No Git writes.';
  }
  return cfg.commit
    ? 'Git: when your focused checks pass, commit your work for this slice. Stage explicit paths only (never `git add -A`, `git add .` or `commit -a`); '
      + 'never stage the pre-existing changes listed above or `.agents_work/`. Use the repository\'s commit-message convention. '
      + 'Repairs are new commits: never amend, rebase, reset, force or push.'
    : 'Git: do not stage, commit, switch branches or push. Leave your changes in the working tree.';
}

function writeAssignment(role, purpose, slice, task) {
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

function resultPathFor(role, purpose) {
  return path.join(ctx.relayDir, `${String(++state.seq).padStart(3, '0')}-${role}-${purpose}.result.json`);
}

// A message is { role, purpose, text, initial } where `initial` messages create a new assignment.
function queue(msg) { state.cur.queued = msg; save(); }

// ---------- delivery and waiting ----------

function readResult(file, since) {
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  if (st.mtimeMs < since - 2000) return null;
  try {
    return { ...JSON.parse(fs.readFileSync(file, 'utf8')), _path: file, _mtime: st.mtimeMs };
  } catch (e) {
    return { status: 'invalid', summary: `Unparseable result JSON: ${e.message}`, _path: file, _mtime: st.mtimeMs };
  }
}

function valid(role, r) {
  if (!r || !STATUSES[role].includes(r.status)) return false;
  if (role === 'reviewer' && r.status === 'done') return ['accept', 'changes-required'].includes(r.verdict);
  if (role === 'advisor' && r.status === 'done') {
    return typeof r.decision === 'string' && r.decision.trim() !== '' && (r.slice === undefined || r.slice === null || validSliceSpec(r.slice));
  }
  return true;
}

// A prerequisite slice chosen by the owner: one-line title and at least one acceptance condition.
function validSliceSpec(s) {
  const line = (x) => typeof x === 'string' && x.trim() !== '' && !x.includes('\n');
  return Boolean(s) && line(s.title) && Array.isArray(s.acceptance) && s.acceptance.length > 0 && s.acceptance.every(line)
    && (s.notes === undefined || typeof s.notes === 'string');
}

// Wait until the agent settles, handling permission prompts by waiting for the operator.
function settle(agent, status) {
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
function markRunaway(agent, p, u, interrupted) {
  p.runaway = { compactions: u.compactions, turns: u.turns };
  save();
  clearLive();
  const what = `${interrupted ? 'interrupted' : 'stopped'} after ${plural(u.compactions, 'compaction')} in one step`;
  event(C.red('\u25a0'), `${roleTag(agent.role)} ${C.red(what)} ${C.gray(`\u00b7 ${plural(u.turns, 'turn')}`)}`);
  log(`${state.cur.slice} ${agent.role} ${what} (${u.turns} turns)`, { quiet: true });
  emit('runaway', { role: agent.role, purpose: p.purpose, compactions: u.compactions, turns: u.turns, interrupted });
}

function interruptRunaway(agent, p, u) {
  markRunaway(agent, p, u, true);
  for (let i = 0; i < 6; i++) {
    herdr(['agent', 'send-keys', agent.name, 'Escape'], { allowFail: true });
    const r = herdr(['agent', 'wait', agent.name, '--until', 'idle', '--until', 'done', '--timeout', '20000'], { allowFail: true });
    if (!r.error) return;
  }
}

// Submit and return once the agent has picked the prompt up; settle() does the long wait.
function prompt(agent, text) {
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
function submitPendingInput(agent) {
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
function composeText(msg, resultPath, needsAssignment) {
  if (!needsAssignment) {
    return `${msg.text}\n\nYour assignment is still ${state.cur.assignments[msg.role]}. `
      + `Write this step's result JSON (same format) to: ${resultPath}`;
  }
  return `/${TEMPLATE[msg.role]} Read and execute the relay assignment at ${state.cur.assignments[msg.role]}`
    + (msg.initial ? '' : `\n\nThen, as the current step: ${msg.text}`)
    + `\n\nResult file for this step: ${resultPath}`;
}

function send(msg) {
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

const advisorEnabled = () => cfg.advisor?.enabled !== false && Boolean(cfg.roles?.advisor?.model);

function showBrief(agent, r) {
  if (!r.brief) return showQuestion(agent, r); // e.g. the advisor itself reports blocked
  const b = r.brief;
  const rec = Number(b.recommended) || 0;
  const options = Array.isArray(b.options) ? b.options : [];
  log(`${state.cur.slice} decision needed: ${b.title} \u2014 ${b.question}`, { quiet: true });
  notify(`Relay ${ctx.topic}: decision needed`, `${b.title}${rec && options[rec - 1] ? `\n\u2605 ${rec}. ${options[rec - 1].label}` : ''}`);
  callout(C.magenta, `Decision needed: ${b.title}`, [
    b.question,
    b.context && C.dim(b.context),
    ...options.map((o, i) => `${i + 1 === rec ? C.yellow('\u2605') : ' '} ${i + 1}. ${o.label}${o.consequence ? C.dim(` \u2014 ${o.consequence}`) : ''}`),
    rec && b.reason ? `${C.yellow('\u2605')} ${C.dim(`Recommended: ${b.reason}`)}` : null,
    ...(Array.isArray(b.notes) ? b.notes : []).filter(Boolean).map((n) => C.dim(`Note: ${n}`)),
    C.dim(`Answer in tab "${agent.label}". A number is enough; you can also ask it questions.`),
  ]);
}

function recordDecision(slice, final) {
  const header = `# Owner decisions: ${ctx.topic}\n\nRecorded by pi-relay from the owner's answers. Every worker reads this file.\n`;
  const text = fs.existsSync(ctx.decisions) ? fs.readFileSync(ctx.decisions, 'utf8') : header;
  const id = `D${(text.match(/^## D\d+/gm) ?? []).length + 1}`;
  const title = String(final.title ?? 'Decision').replace(/\s+/g, ' ').trim();
  fs.writeFileSync(ctx.decisions, `${text.trimEnd()}\n\n## ${id} \u00b7 ${new Date().toISOString().slice(0, 10)} \u00b7 ${slice.id} \u00b7 ${title}\n\n${final.decision.trim()}\n`);
  return { id, title };
}

// Returns true when the waiting worker has received the owner's decision; false to fall back to
// asking the owner directly in the worker's tab.
function consultAdvisor(worker, p, r) {
  const c = state.cur;
  const slice = currentSlice();
  const fallback = (why, what = 'could not prepare a brief') => {
    log(`${slice.id} advisor unavailable (${why}); asking the owner directly`, { quiet: true });
    event(C.yellow('\u26a0'), `${roleTag('advisor')} ${C.yellow(what)} ${C.dim(`\u00b7 ${why}; asking you directly`)}`);
    closeAgent('advisor');
    c.advice = null;
    save();
    return false;
  };
  let a = c.advice?.workerMtime === r._mtime ? c.advice : null; // resume an advisor already working on this question
  if (!a) {
    closeAgent('advisor');
    a = c.advice = { workerRole: worker.role, workerMtime: r._mtime, briefPath: resultPathFor('advisor', 'brief'), startedAt: Date.now(), sent: 0 };
    c.assignments.advisor = writeAssignment('advisor', 'advise', slice,
      `The ${worker.role} is waiting for the owner. Its result, with its question, is ${r._path}; its record is `
      + `${artifactPath(worker.role, slice.id)}${fs.existsSync(artifactPath(worker.role, slice.id)) ? '' : ' (not written yet; that is normal when it asks early)'}. `
      + `Owner decisions so far: ${ctx.decisions}${fs.existsSync(ctx.decisions) ? '' : ' (none yet)'}. Write the brief, wait for the `
      + 'owner to answer in this session, then write the decision and the replies (the waiting worker is the '
      + `${worker.role}). `
      + (sliceChanged()
        ? 'This slice already has commits or changes since it started, so a prerequisite slice cannot be inserted before it: do not offer that option.'
        : 'This slice has no commits or changes yet, so a prerequisite slice can be inserted before it if the owner chooses one.'));
    save();
    emit('advisor_start', { workerRole: worker.role, question: r.question ?? null });
    event(C.magenta('?'), `${roleTag(worker.role)} ${C.magenta('needs a decision')} ${C.dim('\u00b7 asking the advisor for a plain-language brief')}`,
      r.question ?? r.summary ?? '');
  }
  quotaGate('advisor');
  const { agent } = ensureAgent('advisor');
  const askBrief = (text) => { a.sent = Date.now(); save(); settle(agent, prompt(agent, text)); };
  let brief = readResult(a.briefPath, a.startedAt);
  if (!brief && !a.sent) {
    askBrief(`/advise Read and execute the relay assignment at ${c.assignments.advisor}\n\nResult file for this step: ${a.briefPath}`);
  } else if (!brief && agentAlive(agent)?.agent_status === 'working') settle(agent, 'working');
  brief = brief ?? readResult(a.briefPath, a.startedAt);
  const briefProblem = (b) => (!b ? 'You stopped without writing the brief.'
    : b.status === 'invalid' ? `Your brief file is invalid (${b.summary}).`
      : b.status === 'needs-decision' && (!b.brief?.question || !Array.isArray(b.brief.options))
        ? 'Your brief is incomplete: it needs at least a question and options.' : null);
  const problem = briefProblem(brief);
  if (problem) {
    askBrief(`${problem} Write it to ${a.briefPath} (status "needs-decision") as valid JSON, as your assignment describes, then wait for the owner.`);
    brief = readResult(a.briefPath, a.sent) ?? brief;
  }
  if (!brief) return fallback('no brief written');
  let final = brief;
  if (brief.status === 'needs-decision') {
    if (briefProblem(brief)) return fallback('incomplete brief');
    emit('advisor_brief', { title: brief.brief.title ?? null, options: brief.brief.options.length, recommended: brief.brief.recommended ?? null });
    final = waitForOperator(agent, brief, { show: showBrief, track: false });
    if (final.status === 'invalid' || (final.status === 'done' && !valid('advisor', final))) {
      // A malformed decision file: the owner has answered, so ask once for a corrected file.
      askBrief(`Your result file ${a.briefPath} is invalid (${final.summary ?? 'no decision, or an incomplete slice'}). Rewrite it as valid JSON `
        + 'with status "done", the decision, its title, the replies and, if the owner chose one, the slice with a one-line title and '
        + 'at least one acceptance condition, as your assignment describes. Do not ask the owner again.');
      final = readResult(a.briefPath, a.sent) ?? final;
    }
  }
  // Never let the advisor decide without the owner: a decision must follow a brief the owner saw.
  if (brief.status !== 'needs-decision' || !valid('advisor', final) || final.status !== 'done') {
    const what = brief.status === 'needs-decision' ? 'could not record your decision' : 'could not prepare a brief';
    return fallback(`unexpected advisor result "${final?.status}"`, what);
  }
  const { id, title } = recordDecision(slice, final);
  emit('owner_decision', { id, title, decision: final.decision, workerRole: worker.role, replies: Object.keys(final.replies ?? {}), slice: final.slice?.title ?? null });
  log(`${slice.id} owner decision ${id}: ${title}`, { quiet: true });
  event(C.green('\u2713'), `${C.green(C.bold(`decision ${id}`))} ${title}`, final.decision);
  closeAgent('advisor');
  c.advice = null;
  if (final.slice) {
    if (sliceChanged()) {
      save();
      throw new RelayStop(`Owner decision ${id} asks for a prerequisite slice ("${final.slice.title}") before ${slice.id}, but ${slice.id} `
        + `already has commits or changes, so the relay cannot set it aside. Add the slice to plan.md where it fits and deal with `
        + `${slice.id}'s changes, then re-run pi-relay ${ctx.topic}. The ${worker.role} is still waiting in its tab.`);
    }
    const pre = insertPrerequisite(slice, final.slice, id);
    setAside(pre, { role: worker.role, purpose: p.purpose, text: `Owner decision ${id} (recorded in ${ctx.decisions}): ${final.replies?.[worker.role] ?? final.decision}` });
    return 'set-aside';
  }
  for (const [role, text] of Object.entries(final.replies ?? {})) {
    if (role === worker.role || !text) continue;
    c.notes = c.notes ?? {};
    c.notes[role] = [c.notes[role], `Owner decision ${id} (${ctx.decisions}): ${text}`].filter(Boolean).join('\n\n');
  }
  const reply = final.replies?.[worker.role] ?? final.decision;
  p.sentAt = Date.now();
  save();
  event(C.cyan('\u2192'), `${roleTag(worker.role)} ${C.dim(`decision ${id} delivered`)}`);
  prompt(worker, `Owner decision ${id} (recorded in ${ctx.decisions}):\n\n${reply}\n\nContinue your current step. `
    + `Write this step's result JSON (same format) to: ${p.resultPath}`);
  return true;
}

// Finish the pending exchange: wait, nudge once for a missing result, involve the operator when asked.
// Also used on resume, when the agent may have died or never received the message.
function collect() {
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

function showQuestion(agent, r) {
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
function waitForOperator(agent, r, { show = showQuestion, track = true } = {}) {
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

function currentSlice() {
  const id = state.cur.slice;
  if (id === 'PLAN') return PLAN_SLICE;
  if (id === 'FINAL') return FINAL_SLICE;
  const s = parsePlan().find((x) => x.id === id);
  if (!s) throw new RelayStop(`Slice ${id} disappeared from plan.md. Restore it or remove relay/state.json "cur".`);
  return s;
}

function firstMessage(slice) {
  const prep = slice.needs.map((n) => (n === 'scout' ? 'scout' : 'architect'));
  state.cur.prep = prep;
  if (slice.id === 'PLAN') {
    return { role: 'planner', purpose: 'plan', initial: true, text: `Break the handoff into slices and write ${ctx.plan} in the relay plan format.` };
  }
  if (prep.length) return prepMessage(prep[0], slice);
  return implementMessage(slice);
}

function prepMessage(role, slice) {
  return role === 'scout'
    ? { role, purpose: 'prep', initial: true, text: `Establish the repository facts the implementer needs for slice ${slice.id}.` }
    : { role, purpose: 'prep', initial: true, text: `Settle the consequential design for slice ${slice.id} before implementation.` };
}

function implementMessage(slice) {
  return slice.id === 'FINAL'
    ? { role: 'implementer', purpose: 'final', initial: true, text: FINAL_SLICE.body + ' Report in "checks" exactly what ran and its result.' }
    : { role: 'implementer', purpose: 'implement', initial: true, text: `Implement slice ${slice.id} until its acceptance is met and focused checks pass.` };
}

function reviewMessage() {
  const c = state.cur;
  const candidate = cfg.commit ? `commits ${c.base}..HEAD` : `the working-tree changes since ${c.base}`;
  if (!c.reviewed) {
    return {
      role: 'reviewer', purpose: 'review', initial: true,
      text: `Review the implementation of this slice: ${candidate} (exclude the pre-existing changes listed above). `
        + 'Set verdict "accept" when the slice acceptance is met with no blocking finding. '
        + 'A finding is blocking only if it violates the slice acceptance, the handoff or a project contract, or has a concrete material consequence. '
        + 'Everything else is non-blocking: record it, but do not list it in "blocking".',
    };
  }
  return {
    role: 'reviewer', purpose: `rereview${c.cycle}`,
    text: `The ${c.senior ? 'senior implementer' : 'implementer'} addressed findings ${c.findings.join(', ') || '(see review)'}; the candidate is now ${candidate}. `
      + 'Re-review those repairs and their adjacent regression risk only; do not restart a full audit. Update your review and verdict.',
  };
}

// ---------- escalation ----------
// After repeated review loops (or a returning finding, or a runaway implementer step), a senior
// implementer takes over the slice in a fresh session for a bounded number of review loops.

const escalationCfg = () => (cfg.escalation && cfg.escalation.enabled !== false ? cfg.escalation : null);
const implRole = () => (state.cur?.senior ? 'senior' : 'implementer');

// Repair attempts allowed before the relay stops for the operator (the next rejection beyond it stops).
function repairLimit(c) {
  const e = escalationCfg();
  const extra = c.extraCycles ?? 0;
  if (!e) return (cfg.maxRepairCycles ?? 3) + extra;
  const before = c.senior ? c.juniorRepairs : (e.afterLoops ?? 2) - 1;
  return before + (e.maxLoops ?? 2) + extra;
}

function escalate(reason, step) {
  const c = state.cur;
  const slice = currentSlice();
  c.senior = true;
  c.juniorRepairs = c.cycle - (String(step.purpose).startsWith('repair') ? 1 : 0);
  c.escalation = reason;
  closeAgent('implementer');
  const rc = cfg.roles?.senior ?? {};
  emit('escalation', { from: 'implementer', to: 'senior', reason, reviewLoops: c.cycle, model: rc.model ?? null, thinking: rc.thinking ?? null });
  log(`${slice.id} escalated to senior implementer: ${reason}`, { quiet: true });
  event(C.yellow('\u21e7'), `${C.yellow(C.bold('escalated to senior implementer'))} ${C.gray(`\u00b7 ${shortModel(rc.model)} ${rc.thinking ?? 'medium'}`)}`, reason);
  queue({
    role: 'senior', purpose: step.purpose, initial: true,
    text: `You are the senior implementer taking over this slice: ${reason}. The previous implementer's work is in the `
      + `repository (commits since the slice base and any uncommitted changes) and in ${artifactPath('implementer', slice.id)}; `
      + 'its session is not available to you. Before patching again, check whether the approach itself is wrong; you may rework '
      + `this slice's changes within its scope. Then complete this step:\n\n${step.text}`,
  });
}

function stopOnRunaway(p, r, slice) {
  const c = state.cur;
  if (p.role === 'implementer' && escalationCfg()) {
    return escalate(`the implementer was stopped after ${plural(p.runaway.compactions, 'compaction')} in one step`, { purpose: p.purpose, text: p.text });
  }
  closeAgent(p.role);
  queue({ role: p.role, purpose: p.purpose, initial: true, text: p.text }); // re-run retries in a fresh session
  save();
  throw new RelayStop(`${slice.id}: the ${p.role} was interrupted after ${p.runaway.compactions} compactions in one step `
    + `(limit ${cfg.maxCompactionsPerStep ?? 3}). The slice is probably too big, or the worker is going in circles. Its partial work `
    + `is in the working tree and its session is kept. Re-running pi-relay ${ctx.topic} retries this step in a fresh session; `
    + 'consider splitting the slice in plan.md first.');
}

function sliceChanged() {
  const head = git(['rev-parse', 'HEAD']);
  return head !== state.cur.base || (git(['status', '--porcelain']) ?? '') !== (state.cur.baseStatus ?? '');
}

function transition(r) {
  const c = state.cur;
  const p = c.pending;
  c.pending = null;
  const slice = currentSlice();
  const usage = stepUsage(p);
  if (usage) c.compactions = (c.compactions ?? 0) + usage.compactions;
  emit('step_result', {
    role: p.role, purpose: p.purpose, status: r.status, verdict: r.verdict ?? null,
    blocking: Array.isArray(r.blocking) ? r.blocking : null, summary: r.summary ?? null, question: r.question ?? null,
    checks: r.checks ?? null, durationMs: Date.now() - (p.firstSentAt ?? p.sentAt),
    usage,
  });
  log(`${slice.id} ← ${p.role} ${r.status}${r.verdict ? ` (${r.verdict})` : ''}: ${r.summary ?? ''}`, { quiet: true });
  const facts = [];
  if (r.verdict === 'changes-required') {
    facts.push(C.yellow(`review loop ${c.cycle + 1}/${repairLimit(c) + 1}`));
    const again = (Array.isArray(r.blocking) ? r.blocking : []).filter((id) => (c.findings ?? []).includes(id));
    if (again.length) facts.push(C.red(`${again.join(', ')} again`));
  }
  if (usage) facts.push(C.gray(plural(usage.turns, 'turn')), compactionText(usage.compactions));
  event(resultIcon(r), `${roleTag(p.role)} ${resultLabel(r)}${facts.length ? ` ${C.gray('\u00b7')} ${facts.join(C.gray(' \u00b7 '))}` : ''}`,
    [r.summary, r.question && `Question: ${r.question}`].filter(Boolean).join('\n'));

  if (r.status === 'runaway') return stopOnRunaway(p, r, slice);

  if (HELP_STATUSES[r.status]) {
    c.returnTo = { role: p.role, purpose: p.purpose };
    const helper = HELP_STATUSES[r.status];
    queue({ role: helper, purpose: 'help', initial: true, text: `Answer this question from the ${p.role}, in your artifact: ${r.question}` });
    const limit = (cfg.maxHelpRequests ?? 2) + (c.extraHelp ?? 0);
    if (++c.help > limit) {
      c.extraHelp = (c.extraHelp ?? 0) + (cfg.maxHelpRequests ?? 2);
      save();
      throw new RelayStop(`${slice.id}: more than ${limit} scout/architect requests; this slice is probably badly scoped. `
        + `Last question: ${r.question}. Re-running pi-relay ${ctx.topic} answers it and allows more; or edit plan.md first.`);
    }
    return;
  }

  if (p.purpose === 'help') {
    closeAgent(p.role);
    const back = c.returnTo;
    c.returnTo = null;
    return queue({ ...back, initial: false, text: `The ${p.role} answered your question in ${r.artifact ?? artifactPath(p.role, slice.id)}. Read it and continue your current step.` });
  }

  if (p.role === 'planner') {
    closeAgent('planner');
    const slices = parsePlan();
    if (!slices.length) throw new RelayStop(`The planner finished but ${ctx.plan} has no "## S1: ..." slices.`);
    log(`PLAN has ${slices.length} slices: ${slices.map((s) => s.id).join(', ')}`, { quiet: true });
    event(C.green('\u2713'), `${C.bold(`plan: ${slices.length} slice${slices.length === 1 ? '' : 's'}`)}`, slices.map((s) => `${s.id}  ${s.title}${s.needs.length ? `  [${s.needs.join(', ')}]` : ''}`).join('\n'));
    return finishSlice();
  }

  if (p.purpose === 'prep') {
    closeAgent(p.role);
    c.prep.shift();
    return queue(c.prep.length ? prepMessage(c.prep[0], slice) : implementMessage(slice));
  }

  if (p.role === 'implementer' || p.role === 'senior') {
    if (slice.id === 'FINAL' && !c.reviewed && !sliceChanged()) return finishSlice();
    return queue(reviewMessage());
  }

  if (p.role === 'reviewer') {
    c.reviewed = true;
    if (r.verdict === 'accept') return finishSlice();
    const blocking = Array.isArray(r.blocking) ? r.blocking : [];
    const again = blocking.filter((id) => (c.findings ?? []).includes(id));
    c.findings = blocking;
    c.cycle++;
    const repair = {
      purpose: `repair${c.cycle}`,
      text: `Review loop ${c.cycle}: fix the blocking findings ${c.findings.join(', ') || '(see review)'} in ${r.artifact ?? artifactPath('reviewer', slice.id)}. `
        + 'Verify each one first; if you disagree, explain with evidence in your artifact instead of changing code. Run focused checks.',
    };
    const e = escalationCfg();
    if (e && !c.senior && (c.cycle >= (e.afterLoops ?? 2) || (e.onRecurringFinding !== false && again.length))) {
      return escalate(`${plural(c.cycle, 'review loop')} without acceptance${again.length ? `; ${again.join(', ')} came back after a repair` : ''}`, repair);
    }
    queue({ role: implRole(), ...repair });
    if (c.cycle > repairLimit(c)) {
      const more = e ? (e.maxLoops ?? 2) : (cfg.maxRepairCycles ?? 3);
      c.extraCycles = (c.extraCycles ?? 0) + more;
      save();
      throw new RelayStop(`${slice.id}: still not accepted after ${plural(c.cycle, 'review loop')}${c.senior ? ', including the senior implementer' : ''}. `
        + `Read ${artifactPath('reviewer', slice.id)}. Re-running pi-relay ${ctx.topic} allows ${more} more; or edit plan.md/handoff.md first.`);
    }
  }
}

function finishSlice() {
  const c = state.cur;
  closeAll();
  const head = git(['rev-parse', 'HEAD']);
  const commits = c.base && head && head !== c.base ? git(['log', '--format=%h %s', `${c.base}..HEAD`]) : '';
  state.slices[c.slice] = {
    status: 'done', base: c.base, head, cycles: c.cycle, compactions: c.compactions ?? 0,
    escalated: c.senior ? c.escalation : null, finishedAt: now(),
  };
  log(`${c.slice} done${commits ? `; commits:\n    ${commits.split('\n').join('\n    ')}` : ''}`, { quiet: true });
  const n = commits ? commits.split('\n').length : 0;
  emit('slice_done', {
    base: c.base, head, commits: commits ? commits.split('\n') : [], repairCycles: c.cycle, helpRequests: c.help, compactions: c.compactions ?? 0, escalated: Boolean(c.senior),
    durationMs: c.startedAt ? Date.now() - c.startedAt : null,
  });
  const facts = [
    n ? `${n} commit${n > 1 ? 's' : ''}` : 'no commits',
    plural(c.cycle, 'review loop'),
    plural(c.compactions ?? 0, 'compaction'),
    c.senior ? 'escalated to senior' : null,
    c.startedAt ? fmtDuration(Date.now() - c.startedAt) : null,
  ].filter(Boolean).join(' \u00b7 ');
  event(C.green('\u25cf'), `${C.green(C.bold(`${c.slice} done`))} ${C.gray(`\u00b7 ${facts}`)}`);
  if (commits) out(commits.split('\n').map((l) => `${' '.repeat(GUTTER)}${C.yellow(l.slice(0, 7))} ${l.slice(8)}`).join('\n'));
  if (c.slice !== 'PLAN') {
    state.cur = null; // totals now come from finished slices only
    event(C.cyan('\u25b8'), `${C.bold('progress')} ${C.gray('\u00b7')} ${progressText(progress())}`);
    state.cur = c;
  }
  state.cur = null;
  save();
}

// ---------- main loop ----------

function nextSlice() {
  if (!state.slices.PLAN && !fs.existsSync(ctx.plan)) return PLAN_SLICE;
  const pending = parsePlan().find((s) => state.slices[s.id]?.status !== 'done');
  if (pending) return pending;
  return state.slices.FINAL ? null : FINAL_SLICE;
}

function sliceProgress(slice) {
  const pr = progress();
  const pos = slice.id === 'FINAL' ? 'final' : slice.id === 'PLAN' ? 'planning' : `slice ${pr.index(slice.id)}/${pr.slices}`;
  return [pos, pr.criteria ? `acceptance ${pr.criteriaMet}/${pr.criteria}` : null].filter(Boolean).join(' \u00b7 ');
}

// ---------- prerequisite slices ----------
// A slice can be set aside while a prerequisite slice runs first: either the owner chose one through the
// advisor (the relay inserts it into plan.md), or the owner added one to plan.md ahead of the current slice
// and re-ran the relay. Only an untouched slice (no commits or changes since it started) is set aside. Its
// state, including its workers' sessions, is kept; afterwards the same workers resume from the new HEAD.

// Writes the owner's prerequisite slice into plan.md just before `current` and returns its id: the
// previous slice's number with the next free letter (S2 -> S2b, S2c, ...; S0 before S1).
function insertPrerequisite(current, spec, decisionId) {
  const plan = parsePlan();
  const at = plan.findIndex((s) => s.id === current.id);
  const prev = at > 0 ? plan[at - 1].id.match(/^S(\d+)([A-Z]?)$/) : null;
  const num = prev ? prev[1] : '0';
  const taken = new Set([...plan.map((s) => s.id), ...Object.keys(state.slices), ...Object.keys(state.setAsideSlices ?? {})]);
  const candidates = [...(prev ? [] : ['']), ...'BCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !prev?.[2] || l > prev[2])];
  const letter = candidates.find((l) => !taken.has(`S${num}${l}`));
  if (letter === undefined) {
    throw new RelayStop(`No free slice id before ${current.id} for the prerequisite slice "${spec.title}" (owner decision ${decisionId}). `
      + `Add it to plan.md yourself, then re-run pi-relay ${ctx.topic}.`);
  }
  const id = `S${num}${letter.toLowerCase()}`;
  const oneLine = (x) => String(x).replace(/\s+/g, ' ').trim();
  const block = [
    `## ${id}: ${oneLine(spec.title)}`,
    'Needs: none',
    'Acceptance:',
    ...spec.acceptance.map((a) => `- ${oneLine(a)}`),
    `Notes: Prerequisite for ${current.id}, inserted by pi-relay from owner decision ${decisionId}.${spec.notes ? ` ${oneLine(spec.notes)}` : ''}`,
    '',
  ];
  const lines = fs.readFileSync(ctx.plan, 'utf8').split('\n');
  const heading = new RegExp(`^##\\s+${current.id}\\s*[:\u2014\u2013-]`, 'i');
  const where = lines.findIndex((l) => heading.test(l));
  if (where < 0) throw new RelayStop(`Could not find slice ${current.id} in ${ctx.plan} to insert the prerequisite slice before it.`);
  lines.splice(where, 0, ...block);
  fs.writeFileSync(ctx.plan, lines.join('\n'));
  const inserted = parsePlan().find((s) => s.id === id.toUpperCase());
  if (!inserted) throw new RelayStop(`The prerequisite slice ${id} written to ${ctx.plan} could not be read back.`);
  log(`${id} inserted into plan.md before ${current.id} (owner decision ${decisionId}): ${oneLine(spec.title)}`, { quiet: true });
  return inserted.id;
}

// Keeps the current slice's state (and its workers' sessions) and closes its tabs, so `before` runs first.
// `resume` is the message for the worker that continues when the slice resumes (null: keep the queued step).
function setAside(before, resume) {
  const c = state.cur;
  closeAgent('advisor');
  c.advice = null;
  const agents = { ...c.agents };
  closeAll();
  c.agents = agents; // closed tabs; their session files are resumed later
  state.setAsideSlices = { ...state.setAsideSlices, [c.slice]: { cur: c, before, resume, at: now() } };
  emit('slice_set_aside', { slice: c.slice, before });
  log(`${c.slice} set aside: ${before} runs first; then ${c.slice} resumes with the same workers`, { quiet: true });
  event(C.yellow('\u21b7'), `${C.yellow(`${c.slice} set aside`)} ${C.dim(`\u00b7 ${before} runs first; then ${c.slice} resumes with the same workers`)}`);
  state.cur = null;
  save();
}

// The owner added an unfinished slice to plan.md ahead of the current one and re-ran the relay.
function setAsideForEarlierSlice() {
  const c = state.cur;
  if (!c || c.slice === 'PLAN' || c.slice === 'FINAL') return;
  const plan = parsePlan();
  const at = plan.findIndex((s) => s.id === c.slice);
  const earlier = at > 0 ? plan.slice(0, at).find((s) => state.slices[s.id]?.status !== 'done') : null;
  if (!earlier) return;
  if (sliceChanged()) {
    throw new RelayStop(`plan.md now puts ${earlier.id} before the current slice ${c.slice}, but ${c.slice} already has commits `
      + 'or uncommitted changes since it started, so it cannot simply be set aside. Move the new slice after it, or deal '
      + `with ${c.slice}'s changes first, then re-run pi-relay ${ctx.topic}.`);
  }
  const p = c.pending;
  setAside(earlier.id, p ? {
    role: p.role, purpose: p.purpose,
    text: `The owner added slice ${earlier.id} to plan.md before this slice, and it has now been done. If your earlier result `
      + 'asked a question or reported a block, read decisions.md and the plan for the answer.',
  } : null);
}

// Restores a set-aside slice: same state and worker sessions, a new base at the current HEAD (the
// prerequisite's commits are not this slice's work), and the waiting worker told what was done.
function resumeSetAside(slice) {
  const entry = state.setAsideSlices[slice.id];
  delete state.setAsideSlices[slice.id];
  const c = entry.cur;
  const done = state.slices[entry.before];
  const commits = done?.base && done.head && done.head !== done.base ? git(['log', '--format=%h %s', `${done.base}..${done.head}`]) : '';
  state.cur = { ...c, base: git(['rev-parse', 'HEAD']), baseStatus: git(['status', '--porcelain']) ?? '', pending: null, fresh: false, resumed: RUN_ID };
  if (entry.resume) {
    const pre = parsePlan().find((s) => s.id === entry.before);
    queue({
      role: entry.resume.role, purpose: entry.resume.purpose, initial: false,
      text: `${entry.resume.text}\n\nThe prerequisite slice ${entry.before}${pre ? ` ("${pre.title}")` : ''} is done`
        + `${commits ? `; its commits:\n${commits}` : ' (no commits)'}.\nThis slice's base is now ${state.cur.base}: `
        + 'review covers only changes made after it. Continue your current step.',
    });
  }
  emit('slice_resumed', { before: entry.before, base: state.cur.base });
  log(`${slice.id} resumed after ${entry.before}; new base ${state.cur.base}`, { quiet: true });
  heading(`${slice.id}  ${slice.title}`, `resumed after ${entry.before} \u00b7 ${sliceProgress(slice)}`);
  save();
}

function runSlice(slice) {
  if (!state.cur && state.setAsideSlices?.[slice.id]) resumeSetAside(slice);
  if (!state.cur) {
    state.cur = {
      slice: slice.id, base: git(['rev-parse', 'HEAD']), baseStatus: git(['status', '--porcelain']) ?? '',
      cycle: 0, help: 0, agents: {}, assignments: {}, pending: null, queued: null, prep: [], findings: [],
      startedAt: Date.now(), fresh: true, resumed: RUN_ID,
    };
    emit('slice_start', { title: slice.title, needs: slice.needs, base: state.cur.base });
    log(`${slice.id} start: ${slice.title}`, { quiet: true });
    heading(`${slice.id}  ${slice.title}`, sliceProgress(slice));
    queue(firstMessage(slice));
  }
  if (state.cur.resumed !== RUN_ID) {
    state.cur.resumed = RUN_ID;
    if (!state.cur.fresh) heading(`${slice.id}  ${slice.title}`, `resumed \u00b7 ${sliceProgress(slice)}`);
  }
  state.cur.fresh = false;
  while (state.cur) {
    let r;
    if (state.cur.pending) r = collect();
    else if (state.cur.queued) r = send(state.cur.queued);
    else throw new RelayStop(`${state.cur.slice} has no next step recorded; inspect relay/state.json.`);
    if (r?.status === 'set-aside') break; // the prerequisite slice is next in plan.md
    transition(r);
    save();
  }
}

function printStatus() {
  const slices = parsePlan();
  out(`${C.bold(`pi-relay \u00b7 ${ctx.topic}`)}  ${C.gray(ctx.project)}`);
  out(`${C.gray('progress')}  ${progressText(progress())}`);
  out('');
  const all = [...(fs.existsSync(ctx.plan) ? [] : [PLAN_SLICE]), ...slices, FINAL_SLICE];
  const titleWidth = Math.min(48, Math.max(...all.map((x) => x.title.length)));
  for (const s of all) {
    const done = state.slices[s.id]?.status === 'done';
    const current = state.cur?.slice === s.id;
    const aside = state.setAsideSlices?.[s.id];
    const mark = done ? C.green('\u2713 done       ') : current ? C.cyan('\u25b6 in progress')
      : aside ? C.yellow(`\u21b7 after ${aside.before.padEnd(4)}`) : C.gray('\u00b7 todo       ');
    const shown = s.title.length > titleWidth ? `${s.title.slice(0, titleWidth - 1)}\u2026` : s.title.padEnd(titleWidth);
    const title = done ? C.dim(shown) : current ? C.bold(shown) : shown;
    const rec = current ? { cycles: state.cur.cycle, compactions: state.cur.compactions ?? 0 } : state.slices[s.id];
    const facts = [];
    if (s.acceptance) facts.push(`acceptance ${done ? s.acceptance : 0}/${s.acceptance}`);
    if (rec && (done || current)) facts.push(plural(rec.cycles ?? 0, 'review loop'), compactionText(rec.compactions ?? 0));
    if ((current && state.cur.senior) || (done && rec?.escalated)) facts.push(C.yellow('escalated'));
    const factText = facts.map((f) => (f.includes('\x1b') ? f : C.gray(f))).join(C.gray(' \u00b7 '));
    out(`  ${C.bold(s.id.padEnd(6))} ${mark}  ${title}${facts.length ? `   ${factText}` : ''}`);
  }
  if (state.cur) {
    const step = state.cur.pending ?? state.cur.queued;
    out('');
    out(`  ${C.gray('current step')}  ${step ? `${roleTag(step.role)} ${purposeLabel(step.purpose)}${state.cur.pending ? C.gray(' (sent)') : C.gray(' (queued)')}` : 'none'}`);
    if (state.cur.cycle) out(`  ${C.gray('repair cycles')} ${state.cur.cycle}`);
    for (const a of Object.values(state.cur.agents)) out(`  ${C.gray('open tab')}      "${a.label}"`);
  }
  out('');
}

// Static totals for the startup header; on a resumed run, also what is already done.
function planSummary(pr) {
  const done = (n, word) => (n ? C.gray(` (${n} ${word})`) : '');
  return [
    `${plural(pr.slices, 'slice')}${done(pr.slicesDone, 'done')}`,
    pr.criteria ? `${pr.criteria} acceptance criteria${done(pr.criteriaMet, 'met')}` : null,
  ].filter(Boolean).join(C.gray(' \u00b7 '));
}

function banner() {
  const slices = parsePlan();
  const models = ['planner', 'scout', 'architect', 'implementer', 'senior', 'reviewer', 'advisor']
    .filter((r) => cfg.roles?.[r])
    .map((r) => `${(ROLE_COLOR[r] ?? C.bold)(r)} ${C.dim(`${shortModel(cfg.roles[r].model)}/${cfg.roles[r].thinking ?? 'medium'}`)}`);
  const row = (k, v) => out(`${C.gray('\u2502')}  ${C.gray(k.padEnd(8))} ${v}`);
  out('');
  out(`${C.gray('\u256d\u2500')} ${C.bold(`pi-relay \u00b7 ${ctx.topic}`)}`);
  row('project', ctx.project);
  row('plan', slices.length ? planSummary(progress()) : C.dim('no plan yet (the planner goes first)'));
  row('git', cfg.commit ? 'commits each slice locally \u00b7 never pushes' : 'no commits (working tree only)');
  row('models', models.slice(0, 3).join(C.gray('  \u00b7  ')));
  if (models.length > 3) row('', models.slice(3).join(C.gray('  \u00b7  ')));
  out(C.gray('\u2570\u2500'));
}

function main() {
  const args = process.argv.slice(2);
  const topic = args.find((a) => !a.startsWith('-'));
  if (!topic || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: pi-relay <topic> [--status]\nRun from the project checkout, inside a Herdr pane. See README.md.');
    return 0;
  }
  setup(topic);
  if (args.includes('--status')) { printStatus(); return 0; }
  if (process.env.HERDR_ENV !== '1') throw new RelayStop('Run pi-relay inside a Herdr pane (HERDR_ENV=1).');
  ctx.workspace = herdr(['pane', 'current', '--current']).pane.workspace_id;
  acquireLock();
  save();
  emit('run_start', {
    project: ctx.project, resumed: Boolean(state.cur), head: git(['rev-parse', 'HEAD']),
    roles: cfg.roles, commit: Boolean(cfg.commit), maxRepairCycles: cfg.maxRepairCycles ?? 3, quota: cfg.quota ?? null,
  });
  log(`relay started in ${ctx.project} (topic ${topic})`, { quiet: true });
  banner();
  setAsideForEarlierSlice();
  for (let slice = state.cur ? currentSlice() : nextSlice(); slice; slice = nextSlice()) runSlice(slice);
  emit('run_complete', { head: git(['rev-parse', 'HEAD']) });
  log('relay complete: all slices and final verification done', { quiet: true });
  callout(C.green, `Relay ${ctx.topic} complete`, ['All slices and the final verification are done.', C.dim(`History: ${path.relative(ctx.project, ctx.logFile)}`)]);
  notify(`Relay ${ctx.topic} complete`, 'All slices and final verification are done.');
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  if (state && ctx.stateFile) save();
  const msg = e instanceof RelayStop ? e.message : `Unexpected error: ${e.stack ?? e}`;
  emit('run_stop', { reason: msg.slice(0, 2000), kind: e instanceof RelayStop ? 'stop' : 'error' });
  if (ctx.logFile) log(`STOPPED: ${msg}`, { quiet: true });
  callout(C.red, 'Relay stopped', [msg, ctx.topic && e instanceof RelayStop ? C.dim(`Resume with: pi-relay ${ctx.topic}`) : null]);
  if (ctx.topic) notify(`Relay ${ctx.topic} stopped`, msg.slice(0, 200));
  process.exitCode = e instanceof RelayStop ? 2 : 1;
}
