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

### D2. The backend stays layered; the frontend goes feature-shaped

No move to feature folders on the backend. Roughly half of it is system-wide
plumbing a feature split would damage: `db/schema.ts` is one data model with conventions that
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

**The frontend is the opposite case.** `apps/web` is where the file count actually
grows: panel rendering, drag and drop, the assign modal, the triage inbox, capture,
focus and deadline badges, per-screen-size layouts, the offline queue's UI. Those are
genuine product concepts with their own local state, so they group by concept:

```
apps/web/src/
  panel/      rendering, drag and drop, the assign modal
  inbox/      the triage flow
  action/     the row, the editor, capture
  shared/     api client, query hooks, SSE, the offline queue
  app/        router, layout, shell
```

Two different problems, two different answers, not a compromise.

**Why the backend answer is the destination and not a stopgap.** Not because the
code is small today. Because of what the finished domain looks like:
functional-definition §4.1 and §4.2 fix seven concepts (Workspace, Page, Panel, Item,
Association, Focus, Deadline) and make them one shared model, where "a Panel is
simply a query over Items", Focus is a flag on an Item and Deadline is a column on
one. Feature folders pay off when a feature owns its data; here `panel/`, `focus/`
and `inbox/` would all query the same table and constantly import each other.

The remaining work reinforces it. Per §13 and sections 5 and 8 to 10, most of what is
left is mechanism rather than features: offline and local-first with queued actions,
reconciliation and staleness, AI enrichment, the triage flow, panel rule
configuration, notification routing, auth and multi-tenancy. Connectors are already
separate packages. So the plumbing grows faster than any feature folder would, which
is the opposite of the condition that justifies inverting.

**What would reopen it.** If Panels, Focus or the triage inbox stop being views over
Items and start owning their own tables and logic. #35's plain-English panel rules
are the most likely candidate. See P9.

### D3. Validation statements are drafted per issue and stored in the source

Plain-English statements of what must be true. Drafted while an issue is being
written, because that is where the scope is small enough to reason about. They do
not stay in the issue: they end up in the source, tied to a feature or component.

The reason they cannot stay: a statement in an issue is a change-spec, and #37 and
#38 will both change action behaviour with nothing marking #36's statements as
outdated.

### D6. Michael owns the intent axis, a checklist owns the failure axis

Michael's advantage is knowing what the product means, for instance that "remove
from panel" and "delete" must not be the same thing. His disadvantage is
exhaustiveness on failure modes: concurrent edits, idempotent retries, ordering,
tenant isolation, empty and huge inputs, partial writes. Those come from a
checked-in checklist. The agent crosses the two axes and shows the result.

### D8. A statement list is rules with case tables, not a flat list

A rule is one behaviour in product language and one test body. Its cases are a table
inside that test, one line each, and what the runner prints per case is the statement.
Nothing is stored separately.

The reason: a flat list enumerates the product surface, and many surface behaviours
are consequences of one rule. Fifteen statements about what appears on a panel are one
rule about what a panel contains.

### D9. Tests exist to give sufficient confidence, not to cover every scenario

Michael's words. A case that no plausible implementation could get wrong is padding,
and padding is what makes a list unreviewable. The operational form of this is the
pruning pass in "How a statement list is generated".

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

### P3. One statement, one proving test *(superseded by D8)*

Written before the rules-and-tables shape. D8 replaces it: one rule is one test body
and many cases, so the mapping is many statements to one test. What survives is the
intent, that a statement is discharged in one place rather than re-proved upward.


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

### P9. Whether to invert the backend into feature folders

One folder per feature holding its queries, logic and routes, plus a `core/` for the
plumbing that belongs to no feature. D2 says no for now; this records the argument
both ways so reopening it is cheap.

What actually differs, once the plumbing is carved out either way:

- **Adjacency.** Layers on top put every query side by side, which is how you check
  a cross-cutting property like "every query filters on tenant_id". Features on top
  put all of one feature's code side by side, which is what an agent working a
  single issue needs.
- **Enforcement.** Today the import rule is a directory rule: nothing under
  `domain/` may import from `db/` or `http/`, and breaking it means moving a file.
  With features on top and layers as filenames (`action/logic.ts`,
  `action/queries.ts`) the same rule becomes a naming convention, which is weaker.
  Testing-strategy §10 prefers making violations impossible over catching them.
- **Deleting a feature** is one folder under features on top, and several edits
  under layers on top.
- **Cross-feature imports.** Panels will reference actions. Under layers that is
  unremarkable; under features it needs a rule about what a feature exposes.

The version that keeps the enforcement is features on top with layers as
subdirectories: `action/domain/`, `action/db/`, `action/http/`. The rule stays a
path rule and stays glob-checkable. The cost is three directories per feature, which
is ceremony while `domain/items.ts` is 96 lines for all seven commands.

**Trigger to revisit, backend only.** Not size. Invert when a feature stops being a
view over Items and starts owning its own tables and logic. Size was the first
trigger proposed and it was the wrong one: 1,574 lines is maybe a tenth of the
finished application, so deciding from it is deciding on the wrong evidence. The
argument that survives is about the shape of the domain, and it is recorded in D2.

The one thing to avoid either way is churning the layout twice.

## Parked, to discuss further

Pulled back out of Decided. Recorded so the reasoning is not lost.

### D4. Enforced test names first, rather than a separate statement store

Try the cheap version before building anything new: the statement is the test name,
with a check that enforces the link. No new artifact, no new format.

### D5. Red-first evidence per statement

A statement that went from nothing to passing without a failing run in between is
not believable, so the failing run is recorded.

### D7. Run the experiment on #36 before building anything *(run, though the decision is still parked)*

Generate the statement list for issue #36, then count how many statements are added,
deleted or materially changed on review. If it is under a fifth, the human review
step is not paying for itself and the design changes.

It was run. The original metric turned out to be the wrong one: the review did not
tweak statements, it changed the shape of the list twice, first from flat statements
to rules with tables, then by pruning cases that nothing could plausibly get wrong.
Both changes came from Michael and neither would have come from the agent. That is a
stronger result than the fraction-changed number would have been, and the method it
produced is recorded below.


## How a statement list is generated (the material for the skill)

Worked out by generating and pruning the list for issue #36. The result is
`statements-issue-36-experiment.md`; this is the method behind it.

### The passes, in order

1. **Read the inputs.** The issue, its comments, the issues it depends on, and the
   existing rules for every capability it touches. The third input is what stops each
   issue writing a fresh list with nothing marking older rules as outdated.
2. **Extract the surface.** Every behaviour the issue literally describes. This pass
   is mechanical and produces a long list. It is not the output.
3. **Collapse the surface into rules.** Find the rule that several surface behaviours
   are consequences of, and write the rule instead. An agent left to itself will skip
   this pass, because the issue is written surface-first. It has to be explicit.
4. **Build each rule's case table.** The transitions that exercise it, and the read
   surfaces each transition is checked against.
5. **Prune.** See the criterion below.
6. **Assign a level per rule** with a one-clause reason, per testing-strategy §1.
7. **Add the failure axes as rules**, not as cases sprinkled through the feature rules.
8. **List what the issue does not answer.** In practice this is one of the most
   valuable outputs, and some of it belongs inside the rules as a missing case rather
   than in a footnote.

### Writing a rule

- Product language. No function names, no HTTP status codes as the subject, no table
  names.
- One rule is one test body.
- The rule says why; the cases say what.
- Prefer a rule whose table grows as the product grows. "An invalid command is
  rejected and writes nothing" and "a command that fails rolls the screen back" each
  absorb every future rule as one more line, with no new test.

### The pruning criterion

Cut a case when either holds:

- **No distinct path.** The cases read the same data through the same query with the
  same parameters. There is one action record and one action list, so "the new title
  shows in the list" is not a second thing that could be wrong.
- **Already exercised.** Something else runs the same code and would go red if it
  broke. Last-write-wins is implemented in `isStale` and already has a unit test, so
  an integration test re-proves it.

"It is obvious" and "it would be hard to get wrong" are not reasons on their own.
Require one of the two above, because the second is checkable and the feeling is not.

**Read surfaces count as separate only when they are separate queries with different
filters.** Panel contents, the Inbox and the action list are three filters. The same
column read back through one query is one surface.

**Who prunes what.** Whether a plausible implementation could get it wrong is often a
design fact only the human has, so those cuts happen at review. Whether two cases
share a code path is an implementation fact, so those cuts happen during the build,
by the agent, and are reported in the pull request.

### The failure axis checklist

Crossed with the intent rules per D6. Each becomes a rule with a growing table:

- concurrent use
- repeat and retry, including idempotent commands
- isolation between workspaces and tenants
- empty and large collections
- partial failure and rollback
- invalid input

### Level assignment

- The lowest level that can prove the behaviour, per testing-strategy §1. Escalating
  because a unit test would prove nothing is that rule working, not an exception.
- Frontend rules are about the UI's own behaviour and its wiring. They do not restate
  a backend rule.
- Expensive tiers are kept thin by a budget, not by a ban on overlap. An end-to-end
  walk crossing a rule that integration already covers is fine; twelve end-to-end
  cases for twelve validation rules is not.

### What the output looks like

The rule, its cases with expected outcomes, the read surfaces, the level, and a
separate list of what was cut with the reason. The cut list is worth keeping: it is
how the pruning criterion gets checked and improved.

Counts at the end, so the review effort is visible.

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
