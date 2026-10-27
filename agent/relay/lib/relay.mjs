// pi-relay: The main loop: running slices, status output and runRelay().

import fs from 'node:fs';
import path from 'node:path';
import { C, callout, compactionText, emit, heading, log, out, purposeLabel, resetConsole, ROLE_COLOR, roleTag, setTTY, shortModel } from './console.mjs';
import { realIo } from './io.mjs';
import { FINAL_SLICE, nextSlice, parsePlan, PLAN_SLICE, planSummary, progress, progressText, sliceProgress } from './plan.mjs';
import { resumeSetAside, setAsideForEarlierSlice } from './prerequisites.mjs';
import { usageCache } from './quota.mjs';
import { cfg, ctx, git, herdr, io, notify, plural, RelayStop, RUN_ID, setCfg, setIo, setRunId, setState, state } from './runtime.mjs';
import { collect, queue, send } from './steps.mjs';
import { acquireLock, save, setup } from './store.mjs';
import { currentSlice, firstMessage, transition } from './transitions.mjs';
import { sessionCache } from './usage.mjs';

export function runSlice(slice) {
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

export function printStatus() {
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

export function banner() {
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

export function main(args) {
  const topic = args.find((a) => !a.startsWith('-'));
  if (!topic || args.includes('-h') || args.includes('--help')) {
    io.write('Usage: pi-relay <topic> [--status]\nRun from the project checkout, inside a Herdr pane. See README.md.\n');
    return 0;
  }
  setup(topic);
  if (args.includes('--status')) { printStatus(); return 0; }
  if (io.env.HERDR_ENV !== '1') throw new RelayStop('Run pi-relay inside a Herdr pane (HERDR_ENV=1).');
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

// Runs the relay with `args` (as on the command line) against `ioImpl`; returns the exit code:
// 0 done, 1 unexpected error, 2 stopped for the owner. Every call starts from fresh in-memory state.
export function runRelay(args, ioImpl = realIo) {
  setIo(ioImpl);
  for (const k of Object.keys(ctx)) delete ctx[k];
  setCfg(undefined);
  setState(undefined);
  setRunId(`${io.pid}-${Date.now()}`);
  setTTY(io.isTTY() && !io.env.NO_COLOR);
  Object.assign(usageCache, { at: 0, data: null, warnedAt: 0 });
  sessionCache.clear();
  resetConsole();
  try {
    return main(args);
  } catch (e) {
    if (state && ctx.stateFile) save();
    const msg = e instanceof RelayStop ? e.message : `Unexpected error: ${e.stack ?? e}`;
    emit('run_stop', { reason: msg.slice(0, 2000), kind: e instanceof RelayStop ? 'stop' : 'error' });
    if (ctx.logFile) log(`STOPPED: ${msg}`, { quiet: true });
    callout(C.red, 'Relay stopped', [msg, ctx.topic && e instanceof RelayStop ? C.dim(`Resume with: pi-relay ${ctx.topic}`) : null]);
    if (ctx.topic) notify(`Relay ${ctx.topic} stopped`, msg.slice(0, 200));
    return e instanceof RelayStop ? 2 : 1;
  }
}
