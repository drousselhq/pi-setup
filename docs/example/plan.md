# Plan: slugify

## S1: The slugify function
Needs: none
Acceptance:
- `slugify` in `src/slugify.js` implements the agreed behaviour and the decided accent rule.
- Unit tests cover them and empty input; `node --test` passes.

## S2: The command
Needs: none
Acceptance:
- `bin/slugify.js` reads its arguments, or standard input when there are none, and prints the slug.
- Empty input prints nothing and exits with status 1; a test covers both paths.
