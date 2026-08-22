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

### D10. Tests live in level folders, owned by their package

`docs/testing-strategy.md` §9 stands as written, no amendment. Unit tests move out of
the source tree.

```
apps/api/tests/{unit,integration}/
apps/web/tests/{unit,service}/
packages/shared/tests/unit/
packages/connectors/*/tests/{unit,contract}/     when connectors land
tests/e2e/                                        at the repo root
```

The level folders belong to the package that owns the tests, so `pnpm --filter` still
works and a package stays self-contained. End-to-end tests sit at the repo root
because they belong to no package. Contract tests sit with their connector, since
§3.3 makes each one about one third party's fixtures.

Michael's reason, which is stronger than the co-location argument it replaced: a
folder is a boundary you can police. §10 already asks for network and filesystem
access disabled in the unit runner and lint rules banning API-client imports under the
unit-test directories. Those are directory rules; under co-location they degrade into
filename globs.

What it makes possible: a Vitest project per level with the unit project given no
database binding, no network and no filesystem; `no-restricted-imports` scoped to
`tests/unit/**`; a CI job per level so a misplaced test is visible.

The cost: an untested module is no longer obvious from looking at the folder.
Mirroring `src/` inside `tests/unit/` gives most of that back, and answering that
question is what the explorer is for.

The two existing tests move: `apps/api/src/domain/items.test.ts` and
`packages/shared/src/shared.test.ts` go to their packages' `tests/unit/`.

### D11. A test declares its capability as the outermost describe

The capability is the outer block, the rule is the one inside it.

```ts
describe('action.assign', () => {
  describe('a panel shows exactly the actions assigned to it', () => {
    // cases
  });
});
```

The reporter emits `action.assign > a panel shows exactly the actions assigned to
it > an action deleted > does not appear in panel A`. The explorer splits on the first
segment. No plugin, no runner-specific feature, greppable, and it survives changing
test framework.

**The registry is deferred, not rejected.** Start with a lint rule that only checks the
outermost describe is a dotted identifier. Add a checked registry in
`packages/shared` the first time a typo splits one capability into two in the
explorer. That is the cheapest path to a working explorer and it defers the
hand-maintained list P6 was worried about until something forces it.

### D12. Seeing what isn't tested

Four separate problems, each with its own answer. Nothing here is a percentage and
nothing here is a gate on a number.

| Problem | Answer | What has to be built |
|---|---|---|
| A statement was approved and nobody wrote the test | Todos, which cannot survive a merge | A CI check that fails on any remaining todo, plus a review check on removals |
| Code exists that no test executes | Merged coverage, reported as a list of files | Coverage config per level, a merge step |
| A rule exists but is missing a case | Branch coverage: a branch nothing takes is dead code or a missing case | The same coverage run, reporting branch locations |
| Rolling any of it up to "Actions" | Capability globs over file paths | A globs file and a check that every source file matches exactly one |

**A statement approved but not written.** A rule that has been agreed but not built is
`describe.todo('the rule')`; a missing row is `it.todo('the case')`. They live in the
real test file at the real level, so there is no pending folder. A pull request cannot
merge with any todo left, so main never has one and a todo is the branch's own
checklist rather than a backlog: the first commit is the approved list, the last commit
has none, and the diff is the burn-down.

That rule needs one guard, because deleting a todo is cheaper than implementing it. A
removed todo must be matched in the same diff by either a test appearing or a cut
comment appearing. Without the guard the rule quietly inverts into "delete the
inconvenient statements".

It also forces a case to be handled elsewhere: a rule that cannot be built because a
product question is unanswered has to become an issue, since it can no longer sit as a
todo. That is right, an unanswered product question belongs in the tracker, but it
means the skill's open-questions output routes to issues rather than into the tests.

**Code no test executes.** Coverage, used only in the zero direction. The objections
in `coverage-reporting-options.md` are objections to coverage as a target: satisfiable
without asserting anything, rewards testing what is easy to reach. Neither applies to
"nothing runs this file", which is unambiguous and needs a test written to change.

The setting that matters is `coverage.all`, so that files no test imported still
appear. Without it the gap is invisible, which is exactly backwards.

```ts
coverage: {
  provider: 'v8',
  all: true,
  include: ['src/**/*.{ts,tsx}'],
  exclude: ['src/**/*.d.ts', '**/index.ts'],
  reporter: ['json', 'text-summary'],
}
```

D10 gives a separate run per level, so the reports have to be merged before anyone
reads them, with `istanbul-lib-coverage` or `nyc merge`. End-to-end stays out of the
union at first: collecting coverage from a real browser and a Worker at once is
awkward and the tier is thin by design.

**A rule missing a case.** Branch coverage. If a rule has nine rows and the code has a
branch nothing takes, that branch is either dead code or a tenth row. It does not
catch every missing case, since a case can be a different value through the same
branch, but it is specific and it points at the exact line.

v8 maps back to TypeScript through source maps and its branch precision suffers for
it. Start with v8, look at whether the reported branch locations make sense, and
switch to `provider: 'istanbul'` if they do not.

**Rolling up to a capability.** D2's naming gives it almost for free: once the action
code is `domain/action.ts`, `db/repo/action.ts`, `http/routes/action.ts` and
`apps/web/src/action/**`, Actions is a glob.

What keeps it honest is the check, not the file: every source file must match exactly
one capability glob or CI fails. A new file matching nothing forces someone to say
where it belongs; a file matching two means the globs overlap. That is what makes this
different from the capability registry considered under P6 and rejected: it maps files
to groups rather than listing capabilities in the abstract, so it can be verified
against the filesystem and cannot silently be wrong.

**What the report says per capability:** files nothing executes, branches nothing
takes with their locations, and file and line counts for scale. Never a percentage.

**What none of this solves,** and it should be said plainly rather than left implied: a
rule nobody ever thought of leaves no trace anywhere, and a missing case that goes
through an already-covered branch leaves none either. Only escapes find those, which
is why P8 matters more now that pruning is deliberate.

**Cost:** roughly a day, and half exists already. The coverage-explorer POC walks the
repository and renders a model; this is a new input to it rather than a new tool.

## Michael's requirements, mechanism not yet chosen

### R1. The explorer shows levels under each product section

Under Actions or Dashboards, something like backend tests, API tests, frontend
tests, so which level is tested is visible at a glance.

### R2. Not writing or reviewing every test case, while the tests still track business cases

The current pain: most tests an agent writes cannot be related back to a business
case. Both halves of this have to hold at once, and no mechanism is chosen yet.

## Proposed, not decided

### P1. `it.todo` as the statement store *(decided, see D12)*

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

### P6. Where the capability list comes from *(closed: no registry, see D11 and D12)*

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
`statements-issue-36-experiment.md`; this is the method behind it. Every rule below
carries an example, because the abstract version of this guidance produced a bad list
twice.

### The passes, in order

1. **Read the inputs.** The issue, its comments, the issues it depends on, and the
   existing rules for every capability it touches. The third input is what stops each
   issue writing a fresh list with nothing marking older rules as outdated.
2. **Extract the surface.** Every behaviour the issue literally describes. Mechanical,
   long, and not the output.
3. **Collapse the surface into rules.** Find the rule that several surface behaviours
   are consequences of, and write the rule instead.
4. **Build each rule's case table.** The transitions that exercise it, and the read
   surfaces each transition is checked against.
5. **Prune.**
6. **Assign a level per rule** with a one-clause reason, per testing-strategy §1.
7. **Add the failure axes as rules**, not as cases sprinkled through the feature rules.
8. **List what the issue does not answer**, moving anything that is really a missing
   case into the rule where it belongs.

Pass 3 is the one an agent skips, because the issue is written surface-first. It has
to be done deliberately.

### Pass 3, collapsing: an example

Issue #36 produces this surface, among others:

- an action created from a panel appears on that panel
- an action created from the dashboard button appears in the Inbox
- assigning an action to a panel takes it out of the Inbox
- an action assigned to two panels appears on both
- removing an action from one of two panels leaves it on the other
- removing an action from its only panel returns it to the Inbox
- deleting an action removes it from every panel
- an action never appears in another workspace

Eight statements, and every one is a consequence of the same thing. Collapsed:

> **A panel shows exactly the actions assigned to it, and the Inbox exactly the ones
> assigned to no panel.**

with the eight as rows in its table. In the real list that rule absorbed fifteen.

The test for whether a collapse is right: if you changed the rule, would every case
under it change too? If a case would survive the rule changing, it belongs to a
different rule.

### Writing a rule

Product language. No function names, no table names, no HTTP status codes as the
subject.

| Bad | Why |
|---|---|
| `commandService` dedupes by `commandId` | Names the implementation. Unreadable as intent. |
| The panel contents query filters on assignment and excludes tombstoned rows | True, and still a mechanism statement. This is the trap on the other side of collapsing: collapse far enough and you stop describing the product. |
| Actions work correctly | Not falsifiable. |

| Good | Why |
|---|---|
| A panel shows exactly the actions assigned to it | Product language, one rule, falsifiable. |
| A repeated command changes nothing the second time | Names the rule, not the mechanism that implements it. |

**Prefer a rule whose table grows as the product grows.**

Bad, three rules that become four the moment a rule is added:

- an action cannot be saved without a title
- an action cannot be saved with a deadline in the past
- an action cannot be assigned to a panel that does not exist

Good, one rule that absorbs all of them and every future one as a table row:

> **An invalid command is rejected and writes nothing.**

The same shape works on the frontend: "a command that fails rolls the screen back"
absorbs every command, rather than one rule per command.

### The pruning criterion

Cut a case when either holds.

**No distinct path.** The cases read the same data through the same query with the
same parameters.

> Cut: "an edited title shows in the action list." There is one action record and one
> list query, so this is not a second thing that could be wrong.

**Already exercised.** Something else runs the same code and would go red if it broke.

> Cut: "when two changes race, the later one wins." Last-write-wins is implemented in
> `isStale`, which already has a unit test.

"It is obvious" and "it would be hard to get wrong" are not reasons on their own.
Require one of the two above, because the second is checkable and the feeling is not.

**Do not over-prune.** The failure mode of a pruning rule is cutting a case that looks
like a duplicate but runs different code.

> Keep: "a deleted action is gone from the action list." The action list is a
> different query with a different filter, and forgetting the tombstone filter in one
> read path while getting it right in another is one of the most common ways this
> breaks.

The signal is always the same question: is there a distinct query, branch or decision
behind this case? If yes, keep it however obvious it looks.

### Read surfaces

Surfaces count as separate only when they are separate queries with different filters.

> Bad: check all twelve transitions against all five of panel A, panel B, panel C, the
> Inbox and the action list. Sixty checks, most of them the same query twice.
>
> Good: check the assignment transitions against the panels involved and the Inbox,
> which are complementary filters, and check the action list only on the transitions
> that change what it returns, which is deletion and workspace.

### Who prunes what

Whether a plausible implementation could get it wrong is often a design fact only the
human has, so those cuts happen at review. Both of the shape changes in the #36
experiment came from Michael, not the agent.

Whether two cases share a code path is an implementation fact, so those cuts happen
during the build, by the agent, and are reported in the pull request. Mark them in the
list when the list is written:

> moved from A to B → on B only *(cut at build time if a move is a remove plus an add
> rather than its own command)*

### The failure axis checklist

Crossed with the intent rules per D6. Each becomes a rule with a growing table, never
cases sprinkled through the feature rules:

- concurrent use
- repeat and retry, including idempotent commands
- isolation between workspaces and tenants
- empty and large collections
- partial failure and rollback
- invalid input

### Level assignment

The lowest level that can prove the behaviour, per testing-strategy §1. Escalating
because a unit test would prove nothing is that rule working, not an exception to it.

The reason has to name what stops a lower level proving it.

| Bad reason | Good reason |
|---|---|
| L2 because it is integration-like | L2 because a panel's contents are a query, so this only holds against a real database |
| F3 because it is user-facing | F3 because the drag only exists in a browser |

**Frontend rules are about the UI's own behaviour and its wiring, never a restatement
of a backend rule.**

> Bad: an end-to-end test for "removing an action from a panel leaves it on the other
> panels". That is a backend rule being re-proved in a browser.
>
> Good: "the remove control sends a remove for this panel." Plus, separately, one
> browser walk per capability proving the whole thing works at all.

Expensive tiers are kept thin by a budget, not by a ban on overlap. A walk that
crosses a rule integration already covers is fine. Twelve browser cases for twelve
validation rules is not.

### What a rule looks like as code

One body, tables as data. Adding a transition is one line.

```ts
describe('a panel shows the actions assigned to it, the Inbox shows the rest', () => {
  const transitions = [
    { name: 'created on a panel',          act: a => a.createOn('A'),             A: true,  inbox: false },
    { name: 'created from the add button', act: a => a.create(),                  A: false, inbox: true  },
    { name: 'assigned to a panel',         act: a => a.create().assign('A'),      A: true,  inbox: false },
    { name: 'removed from its only panel', act: a => a.createOn('A').remove('A'), A: false, inbox: true  },
    { name: 'deleted',                     act: a => a.createOn('A').delete(),    A: false, inbox: false },
  ];

  describe.each(transitions)('an action $name', (t) => {
    let ws;
    beforeEach(async () => {
      ws = await seedWorkspace({ panels: ['A', 'B'] });
      await t.act(ws.actions);
    });

    it.each([
      { where: 'panel A',   read: () => panelContents(ws, 'A'), expected: t.A },
      { where: 'the Inbox', read: () => inboxContents(ws),      expected: t.inbox },
    ])('$verb in $where', async ({ read, expected }) => {
      const contents = await read();
      expect(contents.some(a => a.id === ws.lastActionId)).toBe(expected);
    });
  });
});
```

What the runner prints is the statement list:

```
a panel shows the actions assigned to it, the Inbox shows the rest
  an action created on a panel
    ✓ appears in panel A
    ✓ does not appear in the Inbox
  an action deleted
    ✓ does not appear in panel A
    ✓ does not appear in the Inbox
```

### What the output looks like

The rule, its cases with expected outcomes, the read surfaces, the level with its
reason, and a separate table of what was cut and why. Keep the cut list: it is how the
pruning criterion gets checked and improved, and it is the part a reviewer can
disagree with fastest.

Counts at the end, so the review effort is visible before it is spent.

## Consequences to handle

### C1. `coverage-reporting-options.md` needs amending

Its rows come from workspace globs and layer folders, with capability only a
secondary axis for F3. D1 and R1 make capability the primary axis. Both axes still
exist, but the document's stated preference is now the wrong way round.

### C2. Test file placement contradicts itself today *(resolved by D10)*

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
