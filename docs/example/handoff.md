# Handoff: slugify, a small command-line tool

## Outcome
A Node.js tool that turns text into a URL slug: `slugify "Hello, World!"` prints `hello-world`. It is used by
a static site generator to name pages, so the same input must always give the same slug.

## Scope
- A pure function `slugify(text)` in `src/slugify.js`, with unit tests (`node --test`).
- A command `bin/slugify.js`: the text as arguments, or from standard input when there are none.
- Not in scope: a package release, configuration options, other languages' scripts.

## Agreed behaviour
- Lower case; runs of anything other than letters and digits become one `-`; no `-` at either end.
- Empty input (or input with no letters or digits) prints nothing and exits with status 1.

## Open question
Accented letters (`Crème brûlée`): keep them (`crème-brûlée`) or reduce them to plain letters
(`creme-brulee`). The implementer asks for a decision before writing that part.

## Acceptance
- `node --test` passes, covering the agreed behaviour, the decided accent rule and empty input.
- `echo "Hello, World!" | node bin/slugify.js` prints `hello-world`.

## Authority
Commit locally on the current branch; never push. No new dependencies.
