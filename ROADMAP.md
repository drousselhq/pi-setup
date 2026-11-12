# Roadmap

Improvements considered for the relay and the prompts but not made yet, each with what would bring it
forward. The yardstick is the owner's: quality first (correctness, then maintainability, performance and
architecture), then autonomy (the owner involved only when necessary), through few high-leverage changes.
Items are ordered by expected value.

| Item | Why not yet | Bring it forward when |
|---|---|---|
| **The autonomy drain.** Owner questions with a safe default wait for a decision point instead of stopping the run (stage 2 of `.agents_work/owner-routing/proposal.md`: the council records a deferral to the owner with a `decidedBefore` slice, the relay asks him at that slice's start, and never reports completion with one open) | Stage 1 (November 2026) raised the relay's own limits that sent most questions (in one long project run: 8 of 14 after the routing changes) and now shows, per topic, how many decisions reached the owner, how many took the recommendation and how long the relay waited for him; stage 2 changes the relay's guarantees and needs those measurements first | Stage 1 has run on a topic and its owner questions still stop the run for hours, most of them with a safe default |
| **Project standards instead of cases** (for one project: filing a failing row under a shown cause, admitting references, constants inside a calculation, bookkeeping; `.agents_work/owner-routing/proposal.md` section 2) | The owner judged himself too far from these details to set them well (2026-11-12); his earlier decisions and the project's rules already cover most of their effect on that run | Questions of these kinds keep reaching him after stage 1 |
| **Relay-run acceptance tests, then hard protection.** The relay runs the acceptance tests itself and blocks on changed expectations (rerun before accepting, a defined correction transition, failures not counted as review loops) | Workers report results honestly, and hard protection turns mismatched bindings and wrong tests into disputes and stops | The acceptance pilot shows misreported results or silent expectation changes |
| **Relay-run full verification** of the exact candidate, from a project-declared command | Every final verification so far reported its real outcome | A project lacks a trustworthy harness, or a misreported result is observed |
| **Mechanical detection of weakened tests:** deleted tests, new skips and suppressions, gate exclusions | Weakening a gate now needs authority in the implementer, final-step and reviewer instructions | Weakening recurs despite that (cases so far: two final verification steps) |
| **The reviewer derives one independent input per acceptance clause** on slices without an acceptance phase | It risks padding, and the pilot will show what independent tests are worth | After the acceptance pilot |
| **Reviewer model or thinking changes; a separate provider for acceptance tests** | No evidence yet that either helps | Pilot data or an evaluation set shows a difference |
| **Helper sessions requested by a worker:** the relay starts a separate fresh session (given model, prompt, allowed inputs and output places), links its record into the step, and resumes the worker | The planner and advisor now put evidence production and independent readings in their own slices; one project run (November 2026) needed two such sessions, started by hand | Owner-launched helper sessions recur despite the planning rule |
| **A separate compaction limit for reviewers** | A reviewer stop in a project run came from production work misplaced in a review step; a higher limit would only have cost more | A reviewer's ordinary review, not misplaced work, hits the limit |
| **Risk routing from the actual diff** (more evidence for persistence, concurrency, numerical or real-time changes) | The council's decision classes cover part of it | Data shows risky changes passing with the ordinary evidence |

Project-owned, not here: mutation testing (`cargo-mutants --in-diff`), property and differential tests, and
architecture or dependency rules belong in each project's own verification, which the relay's workers run.
