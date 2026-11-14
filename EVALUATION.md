# Evaluating changes

How changes to the relay, its prompts or a run's rules are judged after they are made, and the register of
what each was expected to do. The aim is to know whether the setup is going the right way and not regressing:
quality first, then the owner's involvement, time and cost. Numbers inform the owner's decision; they never
gate or revert a change by themselves.

## The scorecard

`node scripts/scorecard.mjs PATH...` reads the records relay runs leave (`.agents_work/<topic>/relay/events.jsonl`
and the Pi session files they name) and prints, per topic, a short summary of its finished slices, plus one
line for what lies outside them (unfinished slices, planning, the final verification). `--detail` adds tables
per slice, role and model; `--compare DATE|acceptance` sets two groups of finished slices side by side;
`--since` keeps the slices finished since a date and adds the spend since then; `--until` sets the cutoff;
`--size` adds the lines each slice changed. Its header lists the options. It only reads.

What it counts, and the limits that come with it:

- **Slices** are counted by their id. Planning and the final verification are reported apart. A slice without
  its completion is not finished and not counted. A slice started twice keeps both attempts' cost (the earlier
  attempts' share is shown); its time runs from the last start, without set-aside time inside that interval.
- **Unknown stays unknown.** A field older records lack (the owner's choice, an advisor's `revisits`, the final
  verification's outcome before 2026-11-09) is shown with its known count or as "not recorded", never as zero.
  A slice whose history starts mid-way, or whose worker session is missing or partly unreadable, has a partial
  cost and is left out of cost comparisons; its first review is unknown unless its start and its first review
  are on record. A result is treated as replayed, and counted once, only when every field but the time, run
  and duration is identical and no step was sent in between; a different result of the same step without a new
  send is kept and marked ambiguous.
- **Final outcomes:** the final verification's results and findings, the one mechanical sign of a defect that
  got through.
- **Findings back after repair:** distinct blocking findings a re-review lists again after a repair.
- **Review process** (loops, the first review's verdict, escalations, acceptance tests changed): context, not
  quality. A more lenient reviewer improves all of it.
- **Owner involvement:** decisions (and how many took the recommended option, where recorded), time the run
  waited for him (the same rule as the console's `--status`), split into waits for decisions and other waits
  such as a blocked worker, council decisions and votes it returned to him, and questions that proposed
  revisiting an earlier decision, with who decided them.
- **Time:** a slice's latency, with quota pauses and gaps between relay runs shown beside it, not subtracted:
  workers can go on working while the relay is stopped. Active worker time is not measurable.
- **Cost:** what Pi recorded for every session, each read once (replies, cache warming, compactions), up to the
  cutoff (by default the last event), by slice, role and model. These are price equivalents, not invoices; the
  owner pays by subscription. Review-cycle cost (everything after a slice's first rejection, from the steps'
  own usage, which omits cache warming) and the checking share (review, acceptance, advisor, council) are
  context, not targets. Quota is shown per topic and day as observed account-wide change, shared with other
  sessions; it cannot be attributed to a slice. If Pi's session files are deleted, older costs become partial.
- **Comparing by date** keeps slices finished before the date and slices started after it; a slice running
  across the date is left out and named. `--since` applies to every part of the report.
- **Lines changed** (`--size`) count every file, generated and data files included: a size hint, not a measure
  of work.

## Judging a change

1. **Before looking at outcomes**, a change meant to change outcomes gets a row in the register below: its kind
   (relay code, prompt, run rules), what it should change and why, the guards it must not worsen beyond the
   standing ones, its exposure (which slices it applies to), its boundary and comparison set, and a checkpoint.
   Rows written after the change say so.
2. **Compare like with like:** within one topic and one model configuration where possible, else within one
   project with the configurations shown. Name selection effects (for example, riskier slices chosen for a
   step) and other confounders: model changes, harder work, a mix of versions.
3. **Show** each measure's count of opportunities on both sides (slices, reviews, questions), its median and its
   individual values. No percentage improvements from samples this small.
4. **Read the quality** of the slices compared, accepted ones included: blocking findings by kind and severity,
   whether acceptance was really met, weakened tests, and escapes (a defect in work an earlier slice or topic had
   accepted), with the time since acceptance stated: "no escape seen" is not "no defect". The notes name the
   records read and their dates, so the reading can be repeated.
5. **Verdict,** one line with the numbers: "consistent with the expected improvement", "no clear signal",
   "mixed" or "observed regression". Below about ten opportunities on a side, only "no clear signal" or a single
   serious regression can be said. A guard that got worse is reported even when the expected measure improved.

**Standing guards:** final outcomes, returning findings, the quality reading, the owner's involvement and
recorded cost. A change to the reviewer, the acceptance worker or the senior is judged on these alone; its
review-process figures are context.

Evidence (scorecard output, quality notes, the project and topic) is kept locally in
`.agents_work/evaluation/<ID>/` of the checkout, which is never committed: the register stays project-neutral,
and a fresh clone has the verdicts but not their evidence. Commits of a registered change carry a bullet
`Evaluation: E<n> (EVALUATION.md)`. Display-only changes are not registered.

## Register

| ID | Date | Kind | Change | Expected effect | Specific guards | Exposure, boundary and comparison | Checkpoint | Verdict |
|---|---|---|---|---|---|---|---|---|
| E1 | 2026-11-12 | Relay code and prompts | Owner routing, stage 1: the council keeps answering amended questions within limits (2 changes per decision chain, 6 decisions per step), may grant bookkeeping standing rules, adds no unrequested return-to-owner clauses | Fewer questions reach the owner per slice, so the run waits for his decisions less | Decisions revisited or reversed; findings back after repair | Retrospective row. One long project run: its slices started after the install (first run on 2026-11-12 19:04 UTC) versus those finished before; one slice running across it left out; same models. Confounder: an earlier routing change (2026-11-10) sent later questions of a step to the council too, so the "before" group mixes two regimes | 10 slices after | Open. First look (cutoff 2026-11-14 19:00 UTC; 14 slices after, 21 before): owner decisions 3 versus 19; decision waits 3.1 h versus 20.6 h; 11.7 h of other waiting after it was a worker stopped overnight, not a question. The council returned 3 votes to the owner after, 2 before (counted in his decisions); council decisions 13 versus 18. No quality reading yet |
| E2 | 2026-11-14 | Run rules and prompt | Tests written before the code on more slices of a long project run (with safeguards on changing them); the acceptance worker also tests checks with near-miss inputs | Fewer review loops caused by checkers accepting bad or nearly-right input; independent checks of new reference values | Wrong expectations in the tests; cost per slice (about $10 more expected); latency | Retrospective row. Slices with the acceptance step versus those without in the same run; the riskier slices were chosen for it. The one pilot slice so far predates the near-miss instruction: later slices are the first exposed to it | 5 slices with the step | Open: one slice so far (the pilot) |
