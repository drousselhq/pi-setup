# Contributing

Every change must preserve four things:

- a live setup that keeps working for every Pi session and relay run;
- the owner's installed files: nothing changed in place is overwritten silently;
- relay state that survives interruption and restart;
- a codebase that stays small, dependency-free and practical to review.

Coding agents also follow [AGENTS.md](AGENTS.md).

## Workflow

1. Change files in this checkout, never in `~/.pi/agent`: that directory is the live install, used by
   every Pi session and every relay run.
2. Run `npm test`.
3. For relay changes, also run a real smoke test (below).
4. Commit. Messages: a short subject, then one `-` bullet per real change.
5. Install with `node scripts/install.mjs` when the change should take effect. Installing is the release
   step; check first with `--check`. A relay that is already running keeps the code it started with.
   Each file is replaced atomically, but not the release as a whole: if an install is interrupted, run
   it again. Files already replaced match the checkout and the rest update normally; a leftover
   `*.pi-setup-tmp` file in `~/.pi/agent` can be deleted.

If the installer reports a drifted file, decide which version is right: `--pull FILE` copies the
installed version into the checkout (then commit it); `--force FILE` replaces it with the checkout's.

Keep changes small and coherent: one outcome per commit, with the tests and documentation that make it
complete. Do not mix unrelated changes or local files into a commit.

## Design

- **One module per concern.** The relay's modules are listed in the header of `pi-relay.mjs`. Shared
  relay state changes only through the setters in `runtime.mjs`.
- **Effects at the edge.** Everything outside the relay's own files (Herdr, Git, waiting, notifications,
  the terminal, the network) goes through the `io` object, so the relay runs deterministically in tests.
  The installer plans every change before it writes anything.
- **Extend before adding.** Grow an existing mechanism before creating a parallel one. Add a module,
  abstraction or configuration option only for a current requirement, and keep adjacent cleanup out.
- **No dependencies.** Code uses Node.js built-ins only; adding a package needs the owner's agreement.
- **Fail visibly.** Missing inputs, failed commands and invalid files produce a clear message or a
  recorded blocker, never a silent default or a swallowed error.
- **Generated extensions.** `agent/extensions/herdr-agent-state.ts` and `moshi-hooks.ts` are written by
  Herdr and moshi-hook. Do not edit them; when their tool updates the installed copy, take it back with
  `--pull`.

## Prompts and the relay

The prompts in `agent/prompts/` serve both standalone use (`/implement`, `/review`, …) and relay workers.
The relay owns its protocol: statuses, result-file fields and the advisor's brief and decision. It writes
that protocol into every assignment. Prompts describe role behaviour and refer to "the result format"
rather than restating fields. A protocol change touches the relay and the prompts together, in one commit.

`agent/APPEND_SYSTEM.md`, the prompts and the skill apply to every project. Keep them project-neutral:
a project's tracker, tooling or workflow policy belongs in that project's own instructions.

## Tests

- `npm test` runs every `test/*.test.mjs` with Node's built-in test runner. No dependencies.
- Tests are deterministic. They use temporary directories and the relay test harness's fake Herdr; they
  never touch `~/.pi`, the checkout's tracked files, the network or a real Herdr.
- Test behaviour, not lines: success, invalid input, boundaries, restart and failure paths. Do not add
  tests whose main purpose is execution or that mock away the behaviour under test.
- Every reasonably testable bug fix gets a regression test that fails without the fix. If one is
  genuinely impractical, say why in the commit or your record.
- Never delete, skip or loosen a test to make a run pass. Remove a test only when it is obsolete, wrong,
  redundant or covers deliberately removed behaviour.
- Relay smoke test: run `pi-relay` for real on a throwaway Git repository with cheap models (a
  `relay.json` overriding every role, quota pacing off), inside Herdr, and drive the owner's answers
  through the advisor's tab. Give each concurrent test run its own topic name: Herdr agent names are
  derived from the topic. Delete the throwaway repositories and close their tabs afterwards.

## Completion and evidence

- A change is done when every check it requires has passed: `npm test` for code changes, plus the smoke
  test for relay changes. Documentation-only changes need their links, commands and cross-references
  checked instead.
- Report the commands actually run and their outcome. A check that could not run is reported as not run
  or blocked, never as passed. Earlier results are valid only for the code they ran on.
- Installing is not verification, and `--check` is not a test.

## Review

Substantial changes get an independent review of the actual diff, its requirements and its evidence; a
summary or an "all green" claim is not evidence. Look closely at changes to the installer (what it
overwrites), relay state, locking and restart, and the relay protocol.

Blocking findings need a violated requirement or a concrete, credible consequence, including maintenance
cost. Separate defects, required test gaps and optional improvements. Re-review repairs and the
boundaries they affect, not the whole repository again.

## Source size

Authored `.mjs` and `.ts` files, tests included, have a 300-line soft limit (a file above it needs a clear
cohesion reason) and a 500-line hard limit. Generated extensions are excluded. Split by cohesive
responsibility, never by arbitrary line ranges, forwarding layers or removed comments.

## Documentation

- Update documentation in the same commit as the behaviour, structure or procedure it describes. Each
  kind has one home; [AGENTS.md](AGENTS.md#documentation) lists them.
- Link to the authoritative section instead of copying it.
- Do not document planned behaviour as if it exists.
