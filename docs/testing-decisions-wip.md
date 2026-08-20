# Testing direction: decisions in progress

**Status:** temporary working note, not authoritative. The log of an ongoing
discussion about how testing is driven in this repository. Settled parts move into
`docs/testing-strategy.md` and `docs/coverage-reporting-options.md` when the
discussion ends, the rest become issues, and this file is deleted.

Everything under **Decided** was called by Michael. Everything under **Proposed** is
Claude's suggestion, still open.

## The problem being solved

Three positions the discussion starts from:

1. Development is only fast enough if the agent writes all the test logic.
2. Reading the generated code is not a way to know whether coverage is sufficient.
3. The agent cannot be trusted to pick the right cases or the right level on its own.

## Decided

### D1. Tests are indexed by the product tree

"I want to be able to see which tests I have for actions, dashboards." The code tree
cannot answer that and never will, because `apps/api` and `apps/web` are separate
applications and an end-to-end test belongs to neither. So the product index is
carried by the test and tooling does the joining.

### D2. The code stays layered; features subdivide inside the layers

No move to feature folders. Roughly half the backend is system-wide plumbing a
feature split would damage: `db/schema.ts` is one data model with conventions that
hold across every table, `command-service.ts` is generic over all commands by
design, and the same goes for `client.ts`, `events.ts`, `app.ts`'s wiring,
`tenancy.ts`, `env.ts`, `jobs/`, `ai/` and the connector registry.

The half that does split by feature splits inside its layer, as issues arrive:

```
db/schema.ts             stays whole
db/repo/action.ts        action queries
domain/action.ts         pure action logic
http/routes/action.ts    action route definitions
http/command-service.ts  stays whole
```

Architecture §6.1 is unchanged, and the one-directional import rule keeps making L1
purity a structural fact rather than a convention.

### D3. Validation statements are drafted per issue and stored in the source

Plain-English statements of what must be true. Drafted while an issue is being
written, because that is where the scope is small enough to reason about. They do
not stay in the issue: they end up in the source, tied to a feature or component.

The reason they cannot stay: a statement in an issue is a change-spec, and #37 and
#38 will both change action behaviour with nothing marking #36's statements as
outdated.

### D4. Enforced test names first, rather than a separate statement store

Try the cheap version before building anything new: the statement is the test name,
with a check that enforces the link. No new artifact, no new format.

### D5. Red-first evidence per statement

A statement that went from nothing to passing without a failing run in between is
not believable, so the failing run is recorded.

### D6. Michael owns the intent axis, a checklist owns the failure axis

Michael's advantage is knowing what the product means, for instance that "remove
from panel" and "delete" must not be the same thing. His disadvantage is
exhaustiveness on failure modes: concurrent edits, idempotent retries, ordering,
tenant isolation, empty and huge inputs, partial writes. Those come from a
checked-in checklist. The agent crosses the two axes and shows the result.

### D7. Run the experiment on #36 before building anything

Generate the statement list for issue #36, then count how many statements are added,
deleted or materially changed on review. If it is under a fifth, the human review
step is not paying for itself and the design changes.

## Michael's requirements, mechanism not yet chosen

### R1. The explorer shows levels under each product section

Under Actions or Dashboards, something like backend tests, API tests, frontend
tests, so which level is tested is visible at a glance.

### R2. Not writing or reviewing every test case, while the tests still track business cases

The current pain: most tests an agent writes cannot be related back to a business
case. Both halves of this have to hold at once, and no mechanism is chosen yet.

## Proposed, not decided

### P1. `it.todo` as the statement store

An approved statement lands as `it.todo('...')`. Vitest reports todo as its own
state, so an agreed-but-unproven statement is visible with no new format and no ids.
Without something like this, D4 can only show statements that already have a test,
which is the failure `coverage-reporting-options.md` already identifies in its
option 2.4: a report that cannot show a gap.

### P2. Every test is either a business claim or supporting

A business claim discharges a statement and is written in product vocabulary. A
supporting test proves something mechanical and carries no statement. Both run, only
business claims appear in the business view. Aimed at R2: the tests of
`command-service.ts` are about idempotency, atomicity and staleness and will never
be about actions or panels.

### P3. One statement, one proving test

A statement is discharged by exactly one test, at the lowest level that can prove
it, so a user-level statement does not inflate into five. Supporting tests underneath
carry no statement. Testing-strategy §5.1 is unchanged either way.

### P4. Dotted capability ids

`action.assign`, `panel.deadline`, `dashboard.deadline`. First segment gives the
entity view, last segment gives the cross-cutting view. Matters because #37 and #38
add attributes cutting across actions, panels and dashboards, so no single tree
gives everything one home.

### P5. Columns named by what they prove

An alternative to R1's tech grouping:

| Column | Levels | Answers |
|---|---|---|
| Logic | L1, F1 | Is the behaviour correct, including the edges |
| Wiring | L2, F2 | Does it work against its own real infrastructure |
| Works for a user | L3, F3 | Does it work when everything is connected |
| Still true externally | contract | Do the fakes still match the real third party |

The argument: the tech grouping lumps F1 and F3 together, and F3 is the one §5.1
makes mandatory, so an empty "works for a user" cell is the strongest red signal
available. Michael has not weighed in yet.

### P6. Where the capability list comes from

Michael's answer to this was "not sure, let's discuss". Options on the table: a flat
registry in `packages/shared` next to `commandSchemas`, with an unknown tag failing
CI and a capability with no tests showing red; the file path as the anchor; a tag in
the describe block. Deriving it from feature folder names is off the table now that
D2 keeps the layers.

Roughly half the statements have no command to anchor to. "Dragging an action over a
dashboard name switches dashboards" is not a mutation and never will be.

### P7. A budget on statements per capability

An agent asked for a validation list will produce eighty for an issue like #36, and
skimming eighty is how review becomes theatre. Proposal: rank by consequence, the
top twenty go to review, the rest land unreviewed. Same logic as the §7 run-time
budget.

### P8. The escape loop

Every bug found by using the application becomes a new statement plus a note of
which statement was missing. Without it the explorer is a self-graded exam, because
"is my list complete" is as unanswerable as "is my coverage sufficient".

## Consequences to handle

### C1. `coverage-reporting-options.md` needs amending

Its rows come from workspace globs and layer folders, with capability only a
secondary axis for F3. D1 and R1 make capability the primary axis. Both axes still
exist, but the document's stated preference is now the wrong way round.

### C2. Test file placement contradicts itself today

`testing-strategy.md` §9 mandates `tests/unit`, `tests/integration` and so on. The
two tests that exist are co-located: `apps/api/src/domain/items.test.ts` and
`packages/shared/src/shared.test.ts`. This has to be resolved before #41 builds the
frontend tier, because #41 sets the pattern for everything after it. Two coherent
answers: level folders per §9 as written, or co-location with the level in the
filename (`action.unit.test.ts`) plus per-level runner globs, which means amending
§9.

### C3. Statement ids

D4 makes the test name the key, so rewording a statement looks like a delete plus an
add and the D5 record breaks on a reword. Acceptable while the pull request diff
shows both lines. Revisit if it hurts.

### C4. Where the red-first record lives

D5 needs somewhere to keep it: an append-only map of test name to the commit where
it was first seen failing, written by CI, or reading CI history, which is slower and
breaks when history is pruned.
