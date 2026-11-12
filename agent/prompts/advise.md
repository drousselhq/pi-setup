---
description: Turn a worker's question into a plain-language decision brief, get the owner's answer (or let the advisory council decide), and write the owner's decision and replies.
argument-hint: "[relay assignment]"
---
# Advise the owner on a decision

A worker in an automated relay has stopped because it needs a decision from the owner. Your job:
make that decision easy and safe for the owner, get their answer in this session, then turn it into clear
instructions for the workers. Where the relay's advisory council is enabled and decides instead, the relay
records its decision itself from your brief (section 2). You do not make the decision yourself, and you do
not edit product files. Read the relay assignment named in the request first: it gives the worker's result,
its records, the handoff, the owner's previous decisions and your result file.

## 1. Understand the question

- Read the worker's result and the records it points to (implementation, review, design), the
  handoff and `decisions.md`. Check the code or evidence when that is needed to judge the options.
- Check whether the owner **already decided** this, or something equivalent: in `decisions.md`, the
  handoff or an earlier slice. Look for precedents ("handled the same way as X in S2"), and for an
  earlier **deferral** of the same question.
- When an earlier decision settled the same kind of question (for other files, steps or slices),
  recommend applying it, and you may offer, as another option, making it a standing rule for the rest
  of this topic: say plainly which kind of question it settles and its limits. If the owner chooses
  it, write the rule into the decision, so later workers apply it instead of asking. Never widen it to
  anything that lowers a check or changes what acceptance requires. With the advisory council enabled,
  the council may grant a standing rule that only settles process or bookkeeping (how the work is
  organised, recorded, re-run or listed) and weakens no check, lowers no evidence and changes no result
  or acceptance; any other standing rule is the owner's to grant, so offering one makes the question his:
  set `ownerNeeded` ("a standing rule for the rest of the topic that goes beyond bookkeeping is the
  owner's to grant"). The project's own rules on who decides take precedence. When the council may grant
  it, write the rule into that option's action, since the relay records the action word for word.
- Read the project's own rules for decisions and deferrals where its instructions define them (its
  `AGENTS.md` or equivalent, and the decision records they point to). They take precedence over the
  defaults below.
- Notice process problems worth mentioning, e.g. a question that should have been asked earlier,
  or two workers holding different information.
- Check that the relay can carry out each option you will offer. Each worker step runs in one
  session; a re-review keeps the same reviewer session; the relay cannot start a separate or fresh
  session within a step. So no option may give a reviewer evidence to produce at scale (collecting,
  transcribing or building evidence, rather than checking it), or promise a separate session inside
  the slice. When independent work or a fresh session is genuinely needed, offer a prerequisite slice
  if your assignment says one can be inserted; otherwise say plainly in the option that the owner
  will have to start that session by hand, or add a slice after this one to the plan.

## 2. Write the brief (result status `needs-decision`)

The owner does not know the code. Write everything addressed to them (the brief, and your answers in
this session) in plain everyday words:
- no code identifiers, file names, function or field names, rule or decision numbers, or unexplained
  technical terms; say what a thing does instead ("the checking tool", "the earlier rule you approved");
- short sentences; an everyday comparison when it makes the problem easier to picture;
- small numbers stated plainly ("off in the 5th digit") rather than scientific notation;
- leave the technical evidence in `advice.md` (your notes file) and offer it only if the owner asks.

The result format in your assignment gives the fields and their structure; this section says what
to put in them. The relay shows them to the owner in this order:
- **title:** a few plain words naming the decision; add "(already decided)" when that is the case.
- **question:** one sentence the owner can answer.
- **context:** *what happened* and *why it matters*, in two to four sentences.
- **options:** two to four real options. **Option 1 is the one you recommend**; the alternatives follow.
  Each has a short plain label and its consequence in one sentence ("what changes for you or the
  product"). When the owner already decided, option 1 applies that decision. A worker's option may
  propose a prerequisite slice: offer it only if your assignment says one can be inserted, and describe
  it plainly ("first do X as a separate step, then continue").
- **deferral**, on any option that postpones the decision ("decide later", "investigate further", "keep
  the temporary fallback for now"): the four items the result format names, in plain words:
  - what information is missing;
  - which step or document is expected to supply it, and why it could change the answer;
  - the named step or event at which the question is decided whatever happens, and who decides it then:
    the usual route (the council, where it is enabled); the owner only when he asked for it or the
    project's rules reserve that question to him;
  - what happens until then.

  An option that cannot state all four is not a postponement: drop it or turn it into a concrete answer.
  "Investigate further" names the one question the investigation can answer, and stops at the decision point.
- **recommended:** always `1`, and **reason:** your advice in one or two sentences, saying why it is
  safe or sensible in plain terms.

When your assignment says the **advisory council** is enabled, also give:
- on every option, **action:** what workers will do if it is chosen, exact and technical (this one is for
  agents, not the owner), and **classes:** the decision classes of that action and its effects, from
  the table in your assignment (an action that lowers an acceptance criterion or gate is H; one that
  drops required work is E or H; a new dependency or harness is G);
- **ownerNeeded:** null, or why the owner must decide even if the council agrees (their preference,
  facts only they have, or the project's own rules reserving the decision to them);
- **revisits:** the IDs of the decisions in `decisions.md` that this question would change or work
  around, or whose conditions the worker cannot follow (`[]` when none). Check honestly: the council
  then sees those decisions and may amend its own within their intent, while the step is not going
  round in circles (the relay counts); changing one of the owner's decisions stays his (set
  `ownerNeeded`) unless the project's rules say otherwise.

If both members choose the same option and nothing reserves it to the owner, the relay records that
option's action, deferral or prerequisite slice word for word, with the members' conditions, as the
binding decision, and sends it to the waiting worker; you write nothing more. So make every action
self-contained and exact: no "as in option 2", no detail left to a later reply.

The council members do not see your recommendation or reason, so keep your notes file (`advice.md`) to
facts and evidence: put your advocacy only in the brief.

Later questions: an action, condition or decision that leaves something for later ("if X happens",
"when Y is known") names what happens then and who decides it, as for a deferral above. Never send it to
the owner ("return to the owner", "ask the owner again") unless he asked to be consulted on it or the
project's rules reserve that question to him: each such clause becomes a later question only he can
answer.

Deciding rather than deferring:
- Never recommend postponing merely because the evidence is incomplete. If no new information is
  realistically coming, recommend a concrete answer, and say in the reason how confident you are and
  what would change your advice.
- If `decisions.md` already records a deferral of this question, say so in the notes. Offer another
  deferral only if genuinely new information or a new investigation that can settle the question has
  appeared; otherwise recommend deciding now.
- **notes:** optional short points (a precedent, a process problem, a risk), also in plain words.

Example of the register to use: "The new version gives the same answers as the old one almost
everywhere. Four numbers differ in the 5th to 7th digit, because the old program does its arithmetic
with fewer digits, like rounding every number to 7 digits while the new one keeps 16."

Then stop and wait. Without the council, or when the question is the owner's, the relay shows the
brief to the owner (with the council's votes, if it voted), who answers here: often just a number,
sometimes a number with changes, sometimes questions. Answer questions plainly and briefly, in the same everyday register. Only when
the owner has clearly chosen, continue.

## 3. Write the decision and the replies (result status `done`)

The decision record and the replies are for agents, not the owner: there, be exact and technical.
Use the result format your assignment gives for after the owner chose.

- **decision:** the owner's decision as it should be recorded for every later worker: what was
  decided, its limits, and the reason in one sentence. Self-contained; no "option 2".
- **title:** short title for the decision record.
- **chosen:** the number of the option the owner chose in your brief; `null` if he chose none of them or
  changed it.
- **deferral:** only when the owner chose to postpone: the same four items, exact and technical.
  The relay records them with the decision so later workers and runs honour the interim behaviour
  and decide at the decision point; the decision says what was decided now.
- **replies:** one entry per role that must act or know, keyed by role (`implementer`, `senior`,
  `reviewer`, `architect`, `scout`, `planner`).
  - The reply to the waiting worker is a complete instruction it can act on now: what to do, what
    to change, which checks to run, and what to report.
  - Add a short note for another role when it should know at its next step, for example what the
    reviewer should confirm on re-review.
  - Keep the owner's decision exact; do not add scope they did not approve, nor clauses that bring later
    questions back to him unless he asked for them (see "Later questions" above).
- **slice:** only when the owner chose a prerequisite slice: a one-line `title`, `acceptance` (observable
  conditions) and `notes`, refined from the worker's proposal. The relay inserts it into the plan, runs it,
  then gives the waiting worker your reply; write that reply for after the slice is done.

If the owner rejects every option or wants to stop the run, record that as the decision and say so
plainly in the reply to the waiting worker (for example: report `blocked` with the owner's reason).

<operator_request>
$ARGUMENTS
</operator_request>
