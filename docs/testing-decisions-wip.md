# Testing direction: decisions in progress

**Status:** temporary working note, not authoritative. This is the log of an ongoing
discussion about how testing is driven in this repository. When the discussion ends,
these become issues and the settled parts move into `docs/testing-strategy.md` and
`docs/coverage-reporting-options.md`. Delete this file at that point.

## The problem being solved

Three positions the discussion starts from:

1. Development is only fast enough if the agent writes all the test logic.
2. Reading the generated code is not a way to know whether coverage is sufficient.
3. The agent cannot be trusted to pick the right cases or the right level on its own.

Two things follow. There has to be a way to see how good the coverage is without
reading code, and a way to steer the agent on what must be tested without writing
individual test cases. A fourth problem surfaced during the discussion and is
arguably the sharpest: most agent-written tests cannot be related back to a
business case, because they are named after the mechanism rather than the behaviour.

## Decided

### D1. Tests are indexed by the product tree, not the code tree

The question "what tests do I have for actions" has to be answerable. The code tree
cannot answer it, and never will: `apps/api` and `apps/web` are separate
applications and an end-to-end test belongs to neither. So the product index is a
label carried by the test, and tooling does the joining.

### D2. The code stays layered; features subdivide inside the layers

No move to feature folders. Roughly half the backend is system-wide plumbing that a
feature split would damage: `db/schema.ts` is one data model with conventions that
hold across every table, `command-service.ts` is generic over all commands by
design, and the same goes for `client.ts`, `events.ts`, `app.ts`'s wiring,
`tenancy.ts`, `env.ts`, `jobs/`, `ai/` and the connector registry.

The half that does split by feature splits inside its layer, as issues arrive:

```
db/schema.ts          stays whole
db/repo/action.ts     action queries
domain/action.ts      pure action logic
http/routes/action.ts action route definitions
http/command-service.ts  stays whole
```

Architecture §6.1 is unchanged, and the one-directional import rule keeps making
L1 purity a structural fact rather than a convention.

### D3. Validation statements are drafted per issue and stored in the repo

Plain-English statements of what must be true. Drafted while an issue is being
written, because that is where the scope is small enough to reason about. They do
not stay in the issue: a statement in an issue is a change-spec, and #37 and #38
will both change action behaviour with nothing marking #36's statements as
outdated. They move into the repository, attached to the capability, and change in
the same pull request that changes the behaviour.

### D4. A statement is stored as `it.todo`, with no separate format

The approved list for an issue is a file of `it.todo('...')` lines. No new artifact,
no schema, no ids. Vitest reports todo as its own state, so the model comes straight
out of the test runner's JSON with nothing to parse.

The alternative, deriving the model only from tests that exist, is rejected for the
reason `coverage-reporting-options.md` already gives against option 2.4: it cannot
show a gap, and the gap is the point.

### D5. Red-first evidence per statement

A statement that went from todo to passing without a failing run in between is not
believable. The failing run is recorded. Mutation testing is the later, stronger
version of the same check; this is the cheap version that works from day one.

### D6. Every test is either a business claim or supporting

A business claim discharges a statement and is written in product vocabulary. A
supporting test proves something mechanical and carries no statement. Both run,
both matter, only business claims appear in the explorer's business view.

This is what makes the fourth problem tractable: the tests of
`command-service.ts` are about idempotency, atomicity and staleness, they will never
be about actions or panels, and they are supporting tests by nature rather than by
failure.

### D7. One statement, one proving test; one capability, at least one frontend test

A statement is discharged by exactly one test, at the lowest level that can prove
it. Supporting tests underneath carry no statement, so a user-level statement does
not inflate into five. Separately, testing-strategy §5.1 is unchanged: every
capability needs at least one frontend test proving it works for a user.

### D8. Capability ids are dotted, entity first

`action.assign`, `panel.deadline`, `dashboard.deadline`. Grouping by the first
segment gives the entity view, grouping by the last gives the cross-cutting view.
Two trees out of one flat list, which matters because #37 and #38 add attributes
that cut across actions, panels and dashboards. No tree gives everything one home.

### D9. The explorer's rows are capabilities

This flips the primary axis in `coverage-reporting-options.md`, where rows come from
workspace globs and layer folders and capability is only a secondary axis for F3.
Both axes still exist. That document needs amending with the reasoning.

## Open

### O1. What the columns are

Proposed: name each column by what it proves rather than where the code lives.

| Column | Levels | Answers |
|---|---|---|
| Logic | L1, F1 | Is the behaviour correct, including the edges |
| Wiring | L2, F2 | Does it work against its own real infrastructure |
| Works for a user | L3, F3 | Does it work when everything is connected |
| Still true externally | contract | Do the fakes still match the real third party |

The alternative is the tech grouping (backend, API, frontend). The argument against
it is that it lumps F1 and F3 together, and F3 is the one §5.1 makes mandatory, so
an empty "works for a user" cell is the single strongest red signal available.

### O2. Where the capability list comes from

A flat registry in `packages/shared` next to `commandSchemas`, with two lint checks:
an unknown tag on a test fails CI, and a capability with no tests and no todos shows
red. It is hand-maintained, which `coverage-reporting-options.md` argues against for
node trees, but it is a short flat list rather than a tree of obligations, and both
directions are checked so it cannot quietly lie.

Deriving it from feature folder names is off the table now that D2 keeps the layers.

### O3. Test file placement

`testing-strategy.md` §9 mandates `tests/unit`, `tests/integration` and so on. The
two tests that exist are co-located (`apps/api/src/domain/items.test.ts`,
`packages/shared/src/shared.test.ts`). That contradiction has to be resolved before
#41 builds the frontend tier, because #41 sets the pattern for everything after it.

Two coherent answers: level folders per §9 as written, or co-location with a level
in the filename (`action.unit.test.ts`) and per-level runner globs. The second means
amending §9.

Related: where pending todos live before a level is chosen. Proposed a pending file
per capability, with the todo moving into a level file when it is implemented, so
the move is one visible diff line.

### O4. Where the red-first record is stored

An append-only map of test name to the commit where it was first seen failing,
written by CI. About thirty lines. The alternative is reading CI history, which
works but is slower and breaks when history is pruned.

### O5. A budget on statements per capability

An agent asked for a validation list will produce eighty for an issue like #36, and
skimming eighty is how the review becomes theatre. Proposed: the agent ranks by
consequence, the top twenty go to review as must-have, the rest land unreviewed as
eligible. Same logic as the §7 run-time budget. A capability needing more than
twenty is a sign the issue is too big.

### O6. How much review is actually needed

Deliberately unresolved. The floor is reading the statement diff on each pull
request, which is around ten lines. Below that the system is only as good as a
judging agent that has never used the product. Options on the table: an agent that
flags statements which restate the implementation rather than the product, sampling
one capability a week instead of every pull request, and the escape loop below.

### O7. The escape loop

Every bug found by using the application becomes a new statement, plus a note of
which statement was missing. The count of statements added after an escape, per
capability, is the only honest answer to "is the coverage sufficient". Without it
the explorer is a self-graded exam.

### O8. Statement ids

Deferred. The test name is the key for now, which means rewording looks like a
delete plus an add. Acceptable while the pull request diff shows both lines. Revisit
if it hurts.

## Next step agreed

Run the skill on issue #36 before building anything: generate the statement list,
then count how many statements are added, deleted or materially changed on review.
If under a fifth, the human review step is not paying for itself and the design
changes.
