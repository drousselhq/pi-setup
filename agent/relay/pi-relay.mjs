#!/usr/bin/env node
// pi-relay: deterministic driver for plan → (scout/architect) → implement → review → repair.
// The script owns sequencing and state; Pi workers in Herdr tabs own all judgment.
// See README.md beside this file for file formats and usage. The code is in lib/:
//   relay.mjs          main loop and runRelay()           transitions.mjs    what follows each result
//   steps.mjs          one worker step: assignment,       advisor.mjs        decisions via the advisor
//                      prompt, result file, waiting       council.mjs        the advisory council's votes
//   prerequisites.mjs  inserted slices, set aside, resume  acceptance.mjs     acceptance tests written before code
//   changes.mjs        whether a slice changed anything
//   agents.mjs         worker tabs and sessions           plan.mjs           plan.md and progress
//   store.mjs          paths, config, state, lock         quota.mjs          Anthropic quota pacing
//   usage.mjs          session token usage                console.mjs        console, log.md, events.jsonl
//   runtime.mjs        shared state and constants         io.mjs             the real outside world
// Tests: test/relay/ in the pi-setup repository.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realIo } from './lib/io.mjs';
import { runRelay } from './lib/relay.mjs';

export { realIo, runRelay };

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runRelay(process.argv.slice(2));
}
