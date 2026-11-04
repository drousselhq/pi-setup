# Roadmap

Improvements considered for the relay and the prompts but not made yet, each with what would bring it
forward. The yardstick is the owner's: quality first (correctness, then maintainability, performance and
architecture), then autonomy (the owner involved only when necessary), through few high-leverage changes.
Items are ordered by expected value.

| Item | Why not yet | Bring it forward when |
|---|---|---|
| **The autonomy drain.** Classify the owner's questions in past runs (64 in 27 topics of one project: 52 from implementers, 9 from architects, 3 from reviewers) and evaluate the advisory council, on by default since late October, over the next runs | The council has decided nothing yet: it ran in 3 runs and was consulted once | Next: it is the largest autonomy lever in the run history |
| **Relay-run acceptance tests, then hard protection.** The relay runs the acceptance tests itself and blocks on changed expectations (rerun before accepting, a defined correction transition, failures not counted as review loops) | Workers report results honestly, and hard protection turns mismatched bindings and wrong tests into disputes and stops | The acceptance pilot shows misreported results or silent expectation changes |
| **Relay-run full verification** of the exact candidate, from a project-declared command | Every final verification so far reported its real outcome | A project lacks a trustworthy harness, or a misreported result is observed |
| **Mechanical detection of weakened tests:** deleted tests, new skips and suppressions, gate exclusions | Weakening a gate now needs authority in the implementer, final-step and reviewer instructions | Weakening recurs despite that (cases so far: two final verification steps) |
| **The reviewer derives one independent input per acceptance clause** on slices without an acceptance phase | It risks padding, and the pilot will show what independent tests are worth | After the acceptance pilot |
| **Reviewer model or thinking changes; a separate provider for acceptance tests** | No evidence yet that either helps | Pilot data or an evaluation set shows a difference |
| **Risk routing from the actual diff** (more evidence for persistence, concurrency, numerical or real-time changes) | The council's decision classes cover part of it | Data shows risky changes passing with the ordinary evidence |

Project-owned, not here: mutation testing (`cargo-mutants --in-diff`), property and differential tests, and
architecture or dependency rules belong in each project's own verification, which the relay's workers run.
