// pi-relay: The main loop: running slices, status output and runRelay().

import fs from 'node:fs';
import path from 'node:path';
import { candidateTree, sliceBaseline } from './changes.mjs';
import { C, callout, compactionText, emit, heading, log, out, purposeLabel, resetConsole, ROLE_COLOR, roleTag, setTTY, shortModel } from './console.mjs';
import { closeTabs } from './agents.mjs';
import { checkCouncilConfig } from './council.mjs';
import { replaceWorker } from './fresh.mjs';
import { realIo } from './io.mjs';
import { checkPlan, FINAL_SLICE, nextSlice, parsePlan, PLAN_SLICE, planSummary, progress, progressText, sliceProgress } from './plan.mjs';
import { resumeSetAside, setAsideForEarlierSlice } from './prerequisites.mjs';
import { usageCache } from './quota.mjs';
import { cfg, ctx, git, herdr, io, notify, plural, RelayStop, RUN_ID, setCfg, setIo, setRunId, setState, state } from './runtime.mjs';
import { collect, queue, send } from './steps.mjs';
import { acquireLock, loadState, save, setup } from './store.mjs';
import { currentSlice, firstMessage, transition } from './transitions.mjs';
import { sessionCache } from './usage.mjs';

export function runSlice(slice) {
  if (!state.cur && state.setAsideSlices?.[slice.id]) resumeSetAside(slice);
  if (!state.cur) {
    const baseline = sliceBaseline(); // first: if Git fails, nothing has changed yet
    if (state.slices.FINAL && slice.id !== 'FINAL') { // new work after the final verification: it must run again
      delete state.slices.FINAL;
      emit('final_invalidated', { slice: slice.id });
      log(`${slice.id} added after the final verification: it will run again`, { quiet: true });
    }
    state.cur = {
      slice: slice.id, ...baseline,
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
    closeTabs(); // the workers the transition released
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
    for (const a of Object.values(state.cur.agents).filter((x) => x.tab)) out(`  ${C.gray('open tab')}      "${a.label}"`);
  }
  out('');
}

export function banner() {
  const slices = parsePlan();
  const models = ['planner', 'scout', 'architect', 'implementer', 'senior', 'reviewer', 'advisor', ...(cfg.council?.enabled ? cfg.council.members ?? [] : [])]
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

// Options: --status, --fresh <role> and --note <text> (only with --fresh). Anything else is refused.
export function parseArgs(args) {
  const o = { topic: null, status: false, help: false, fresh: null, note: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--status') o.status = true;
    else if (a === '--fresh' || a === '--note') {
      const v = args[++i];
      if (v === undefined || v.startsWith('-')) throw new RelayStop(`${a} needs a value.`);
      o[a.slice(2)] = v;
    } else if (a.startsWith('-')) throw new RelayStop(`Unknown option ${a}.`);
    else if (o.topic) throw new RelayStop(`Unexpected argument "${a}" (the topic is "${o.topic}").`);
    else o.topic = a;
  }
  if (o.note !== null && !o.fresh) throw new RelayStop('--note is only used with --fresh <role>.');
  return o;
}

export function main(args) {
  const opts = parseArgs(args);
  const topic = opts.topic;
  if (!topic || opts.help) {
    io.write('Usage: pi-relay <topic> [--status] [--fresh <role> [--note <text>]]\n'
      + 'Run from the project checkout, inside a Herdr pane. See README.md.\n');
    return 0;
  }
  setup(topic);
  if (opts.status) { printStatus(); return 0; }
  if (io.env.HERDR_ENV !== '1') throw new RelayStop('Run pi-relay inside a Herdr pane (HERDR_ENV=1).');
  checkCouncilConfig();
  ctx.workspace = herdr(['pane', 'current', '--current']).pane.workspace_id;
  acquireLock();
  ctx.runStartedAt = Date.now(); // a result written before this is not a final verification this run saw
  loadState(); // what the previous relay left, read under the lock; nothing is written from the earlier read
  closeTabs(); // tabs a killed run released but did not close
  save();
  emit('run_start', {
    project: ctx.project, resumed: Boolean(state.cur), head: git(['rev-parse', 'HEAD']),
    roles: cfg.roles, commit: Boolean(cfg.commit), maxRepairCycles: cfg.maxRepairCycles ?? 3, quota: cfg.quota ?? null,
    council: cfg.council?.enabled ? cfg.council : null,
  });
  log(`relay started in ${ctx.project} (topic ${topic})`, { quiet: true });
  banner();
  // Before any further work, a malformed plan must not silently drop slices or preparation. While the planner
  // is still writing it, its own finish checks it instead.
  if (state.cur?.slice !== 'PLAN') checkPlan();
  if (opts.fresh) replaceWorker(opts.fresh, opts.note);
  setAsideForEarlierSlice();
  let ran = false;
  for (let slice = state.cur ? currentSlice() : nextSlice(); slice; slice = nextSlice()) { ran = true; runSlice(slice); }
  if (!ran && !currentCandidate()) return alreadyComplete();
  emit('run_complete', { head: git(['rev-parse', 'HEAD']), verification: 'pass' });
  log('relay complete: all slices done; the final verification passed', { quiet: true });
  const council = (state.councilDecisions ?? []).map((d) => `  ${d.id} (${d.slice}): ${d.title}`);
  callout(C.green, `Relay ${ctx.topic} complete`, ['All slices are done and the final verification passed.',
    ...(council.length ? [`Decided by the advisory council (in ${path.relative(ctx.project, ctx.decisions)}; yours to overrule):`, ...council] : []),
    C.dim(`History: ${path.relative(ctx.project, ctx.logFile)}`)]);
  notify(`Relay ${ctx.topic} complete`, 'All slices are done and the final verification passed.');
  return 0;
}

// Whether the final verification on record covers the files as they are now (a topic run again after it ended).
const currentCandidate = () => Boolean(state.slices.FINAL?.tree) && state.slices.FINAL.tree === candidateTree();

// A completed topic run again after its files changed: its verification covered an earlier state, so the relay
// does not announce completion for the current one, and starts nothing.
function alreadyComplete() {
  const f = state.slices.FINAL;
  if (f.tree && candidateTree() === null) {
    throw new RelayStop('The relay could not read the checkout\'s files through Git to compare them with the final verification. Check Git, then re-run.');
  }
  const when = f.finishedAt ? `${String(f.finishedAt).slice(0, 16).replace('T', ' ')} UTC` : 'an earlier run';
  emit('run_already_complete', { current: false, head: f.head ?? null });
  log(`already complete; the checkout changed since the final verification of ${when}`, { quiet: true });
  callout(C.yellow, `Relay ${ctx.topic}: already complete, for an earlier state`, [
    `The final verification of this topic covered the state of ${when}${f.head ? ` (${String(f.head).slice(0, 7)})` : ''}; `
      + 'the checkout has changed since, so it does not cover the current state.',
    `To verify the current state, add a slice to ${path.relative(ctx.project, ctx.plan)} (the final verification runs again after it), or start a new topic.`,
  ]);
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
    let msg = e instanceof RelayStop ? e.message
      : diskFull(e) ? `Unexpected error: the disk is full (${e.message}). Free some space, then start pi-relay ${ctx.topic ?? '<topic>'} again.`
        : `Unexpected error: ${e.stack ?? e}`;
    // A relay that did not get the lock must not touch the topic's records: another relay may own them.
    // Recording the stop can fail too (a full disk): the original cause is still reported.
    if (ctx.locked) {
      const unrecorded = [];
      try { save(); } catch (err) { unrecorded.push(`state.json (${err.message})`); }
      try { closeTabs(); } catch { /* listed tabs stay listed and are closed at the next start */ }
      emit('run_stop', { reason: msg.slice(0, 2000), kind: e instanceof RelayStop ? 'stop' : 'error' });
      try { log(`STOPPED: ${msg}`, { quiet: true }); } catch (err) { unrecorded.push(`log.md (${err.message})`); }
      if (unrecorded.length) msg += `\nThis stop could not be recorded in ${unrecorded.join(' or ')}.`;
    }
    callout(C.red, 'Relay stopped', [msg, ctx.topic && e instanceof RelayStop ? C.dim(`Resume with: pi-relay ${ctx.topic}`) : null]);
    try { if (ctx.topic) notify(`Relay ${ctx.topic} stopped`, msg.slice(0, 200)); } catch { /* the message is already shown */ }
    return e instanceof RelayStop ? 2 : 1;
  }
}

const diskFull = (e) => e?.code === 'ENOSPC' || /ENOSPC|no space left on device/i.test(String(e?.message ?? ''));
