// pi-relay: Console output for a human watching the run, plus relay/log.md and relay/events.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { ctx, io, now, plural, RUN_ID, state } from './runtime.mjs';

export let TTY = false; // set at the start of main()

export function setTTY(value) { TTY = value; }

export const sgr = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const C = {
  dim: sgr('2'), bold: sgr('1'), red: sgr('31'), green: sgr('32'), yellow: sgr('33'),
  magenta: sgr('35'), cyan: sgr('36'), gray: sgr('90'),
};

export const ROLE_COLOR = {
  planner: sgr('38;5;213'), scout: sgr('38;5;180'), architect: sgr('38;5;80'),
  implementer: sgr('38;5;75'), senior: sgr('38;5;208'), reviewer: sgr('38;5;141'), advisor: sgr('38;5;220'),
};

export const GUTTER = 11; // width of "  HH:MM  ✓ "

export const hhmm = () => new Date().toTimeString().slice(0, 5);
// Read on every draw: the same run can be viewed on a laptop and on a phone (narrow terminal).

export const termColumns = () => io.columns();

export const width = () => Math.max(20, Math.min(termColumns(), 110));

export const narrow = () => width() < 60;

export const ANSI = /\x1b\[[0-9;]*m/g;

export const visibleLength = (text) => [...String(text).replace(ANSI, '')].length;

// Cut a coloured line to `max` visible characters (keeping colour codes intact), ending with an ellipsis.
export function fitLine(text, max) {
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

export const roleTag = (role) => (ROLE_COLOR[role] ?? C.bold)(role.padEnd(11));

export const shortModel = (m) => String(m).split('/').pop().replace(/^claude-/, '');

export let liveShown = false;

export let liveLength = 0; // visible length of the live line currently on screen

export function resetConsole() { liveShown = false; liveLength = 0; }

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// If the terminal got narrower than the live line on screen, the terminal may have split that line
// over several rows; clearing only the last row would leave fragments, so move to a fresh line instead.
export function leaveOrClearLive(cols) {
  if (!liveShown) return;
  io.write(liveLength > cols - 1 ? '\n' : '\r\x1b[2K');
  liveShown = false;
}

export function clearLive() {
  leaveOrClearLive(termColumns());
}

// A single self-replacing status line (TTY only), e.g. while a worker is busy.
export function live(text) {
  if (!TTY) return;
  // Must never wrap: a carriage return only reaches the start of the last physical line, so a wrapped
  // live line would leave a fragment behind on every update.
  const cols = termColumns();
  leaveOrClearLive(cols);
  const line = fitLine(text, cols - 2);
  io.write(`\r\x1b[2K${line}`);
  liveShown = true;
  liveLength = visibleLength(line);
}

export function out(text = '') {
  clearLive();
  io.write(`${text}\n`);
}

// Word-wrap to the terminal width, measuring visible characters (colour codes excluded).
// `firstPrefix` lets an event's time and icon lead the first line, with `prefix` on continuations.
export function wrap(text, indent, prefix = ' '.repeat(indent), firstPrefix = prefix) {
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
export function activeStyle(text) {
  const codes = String(text).match(/\x1b\[[0-9;]*m/g) ?? [];
  const lastReset = codes.lastIndexOf('\x1b[0m');
  return codes.slice(lastReset + 1).join('');
}

export function event(icon, text, detail) {
  out(wrap(text, 0, ' '.repeat(narrow() ? 4 : GUTTER), `  ${C.gray(hhmm())}  ${icon} `));
  if (detail) out(C.dim(wrap(detail, narrow() ? 4 : GUTTER)));
}

export function heading(title, right = '') {
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

export function callout(color, title, lines) {
  const bar = color('  ┃ ');
  out('');
  out(wrap(C.bold(color(title)), 4, bar));
  for (const l of lines.filter(Boolean)) out(wrap(l, 4, bar));
  out('');
}

// Write a plain event to relay/log.md (and, unless `quiet`, a neutral console line).
export function log(line, { quiet = false } = {}) {
  if (ctx.logFile) fs.appendFileSync(ctx.logFile, `- ${now()} ${line}\n`);
  if (!quiet) event(C.gray('·'), C.dim(line));
}

// Structured history for later evaluation: one JSON object per line in relay/events.jsonl.
// Plain log.md is for reading; this file is for analysis (durations, outcomes, token usage).
export function emit(type, data = {}) {
  if (!ctx.relayDir) return;
  const entry = { t: new Date().toISOString(), run: RUN_ID, topic: ctx.topic, slice: state?.cur?.slice ?? null, type, ...data };
  try { fs.appendFileSync(path.join(ctx.relayDir, 'events.jsonl'), JSON.stringify(entry) + '\n'); } catch { /* history is best-effort */ }
}

// What the topic has asked of the owner, from relay/events.jsonl, so he can see how far he is in the loop: his
// decisions (and, among those where the option he chose was recorded by its number, how many took the recommended
// option, always option 1), the time the relay waited before he answered, and the council's decisions. A wait that
// a stop interrupted counts until that run's recorded stop; one whose end was not recorded (Ctrl-C kills the relay
// without a trace, or the wait is still open) is listed as not timed. Null before anything was asked.
export function ownerSummary() {
  let lines;
  try { lines = fs.readFileSync(path.join(ctx.relayDir, 'events.jsonl'), 'utf8').split('\n'); } catch { return null; }
  const n = { owner: 0, known: 0, recommended: 0, council: 0, waited: 0, untimed: 0 };
  const open = new Map(); // run + role -> start of a wait not yet ended
  const stops = new Map(); // run -> time of its recorded stop
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e.t);
    if (e.type === 'run_stop' && Number.isFinite(at)) stops.set(e.run, at);
    if (e.type === 'owner_decision') {
      n.owner++;
      if (Number.isInteger(e.chosen)) { n.known++; if (e.chosen === 1) n.recommended++; }
    } else if (e.type === 'council_decision') n.council++;
    else if (e.type === 'operator_wait_start' && Number.isFinite(at)) open.set(`${e.run} ${e.role}`, at);
    else if (e.type === 'operator_wait_end') { n.waited += Number(e.waitedMs) || 0; open.delete(`${e.run} ${e.role}`); }
  }
  for (const [key, at] of open) {
    const stop = stops.get(key.slice(0, key.indexOf(' ')));
    if (stop === undefined) n.untimed++;
    else n.waited += Math.max(0, stop - at);
  }
  if (!n.owner && !n.council && !n.waited && !n.untimed) return null;
  return [
    `${plural(n.owner, 'decision')} by you${n.known ? ` (${n.recommended} of ${n.known} the recommended option)` : ''}`,
    `${fmtDuration(n.waited)} waiting before you answered${n.untimed ? ` (plus ${plural(n.untimed, 'wait')} not timed: interrupted or still open)` : ''}`,
    `${plural(n.council, 'decision')} by the council`,
  ].join(' \u00b7 ');
}

export function compactionText(n) {
  const t = plural(n, 'compaction');
  return n >= 3 ? C.red(t) : n >= 1 ? C.yellow(t) : C.gray(t);
}

export const PURPOSE = {
  plan: 'write the plan', prep: 'prepare the slice', implement: 'implement', final: 'final verification', verify: 'verify again', commit: 'commit leftovers',
  review: 'review', help: 'answer a question',
};

export function purposeLabel(p) {
  const m = String(p).match(/^(repair|rereview)(\d+)$/);
  if (m) return `${m[1] === 'repair' ? 'repair' : 're-review'} ${C.gray(`· cycle ${m[2]}`)}`;
  return PURPOSE[p] ?? p;
}

export function resultIcon(r) {
  if (r.status === 'runaway') return C.red('\u25a0');
  if (r.status === 'done') return r.verdict === 'changes-required' ? C.yellow('↻') : C.green('✓');
  if (r.status === 'blocked') return C.red('✗');
  return C.magenta('?');
}

export function resultLabel(r) {
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
