# Testing direction: decisions in progress

**Status:** temporary working note, not authoritative. The log of an ongoing
discussion about how testing is driven here. Settled parts move into
`docs/testing-strategy.md` and `docs/coverage-reporting-options.md` when the
discussion ends, the rest become issues, and this file is deleted.

Everything under **Settled** was decided by Michael; everything under **Still open**
has no decision yet.

## Where the discussion started

Three positions:

1. Development is only fast enough if the agent writes all the test logic.
2. Reading the generated code is not a way to know whether coverage is sufficient.
3. The agent cannot be trusted to pick the right cases or the right level on its own.

So there has to be a way to see how good coverage is without reading code, and a way
to steer the agent on what must be tested without writing individual cases. A fourth
problem surfaced during the discussion and is arguably sharpest: most tests an agent
writes cannot be related back to a business case, because they are named after the
mechanism rather than the behaviour.

---

# Settled

## Tests are organised by product concept, not by code structure

"I want to be able to see which tests I have for actions, dashboards." The code
structure cannot answer that and never will, because the API and the web app are
separate applications and an end-to-end test belongs to neither. So the product
grouping is something the test carries, and tooling does the joining.

## The backend stays layered, the frontend groups by feature

No move to feature folders on the backend: roughly half of it is plumbing a feature
split would damage — the schema is one data model with conventions across every table,
the command service is generic over all commands by design, and so are the database
client, the event stream, app wiring, tenancy, jobs, the AI interface and the
connector registry. The half that does split by feature splits inside its layer:

```
db/schema.ts             stays whole
db/repo/action.ts        action queries
domain/action.ts         pure action logic
http/routes/action.ts    action route definitions
http/command-service.ts  stays whole
```

The architecture's one-directional import rule is unchanged, and it is what makes
unit-testability structural rather than conventional.

**The frontend is the opposite case**, because it is where the file count grows and
those files are real product concepts with their own local state:

```
apps/web/src/
  panel/      rendering, drag and drop, the assign modal
  inbox/      the triage flow
  action/     the row, the editor, capture
  shared/     api client, query hooks, the event stream, the offline queue
  app/        router, layout, shell
```

**Why the backend answer is the destination, not a stopgap.** The functional
definition fixes seven concepts (workspace, page, panel, item, association, focus,
deadline) as one shared model, where a panel is a query over items and focus is a flag
on one. Feature folders pay off when a feature owns its data; here `panel/`, `focus/`
and `inbox/` would all query the same table and constantly import each other. The
remaining work reinforces it: most of what is left is mechanism — offline queues,
reconciliation, AI enrichment, triage, panel rules, notification routing, auth,
multi-tenancy — so the plumbing grows faster than any feature folder would.

**What would reopen it:** panels, focus or triage ceasing to be views over items and
starting to own their own tables and logic. The plain-English panel rules (issue 35)
are the likeliest candidate.

## What must be true is written per issue and kept in the source

Plain-English statements of what must be true, drafted while an issue is written
because that is where the scope is small enough to reason about. They do not stay in
the issue: they end up in the source as test names, because a statement written
against a change goes stale silently — deadlines (issue 37) and goals (issue 38) both
change action behaviour, and nothing would mark the statements written for issue 36 as
outdated.

## Michael says what matters, a checklist covers the ways things break

Michael's advantage is knowing what the product means, for instance that removing an
action from a panel and deleting it must not be the same thing. His disadvantage is
being exhaustive about failure modes, which is what the checked-in checklist covers.
The agent crosses the two.

## A statement list is rules with tables underneath, not a flat list

A rule is one behaviour in product language and one test body; its cases are a table
inside that test, and what the runner prints per case is the statement. A flat list
enumerates the product surface, and many surface behaviours are consequences of one
rule — fifteen statements about what appears on a panel are one rule about what a
panel contains. Because the printed names *are* the statement list, there is no
separate file to keep in sync, which is the thing that killed this idea every previous
time anyone tried it.

## Tests are for confidence, not for covering everything

A case no plausible implementation could get wrong is padding, and padding is what
makes a list unreviewable.

## Tests live in folders per level, inside their package

The testing strategy's directory rule stands as written; unit tests move out of the
source tree.

```
apps/api/tests/{unit,integration}/
apps/web/tests/{unit,service}/
packages/shared/tests/unit/
packages/connectors/*/tests/{unit,contract}/     when connectors land
tests/e2e/                                        at the repo root
```

Michael's reason, stronger than the co-location argument it replaced: **a folder is a
boundary you can police.** The strategy already asks for network and filesystem access
disabled in the unit runner and lint rules banning API-client imports — rules about
directories, which degrade into rules about filenames if tests sit beside the code.
That makes possible a Vitest project per level with no bindings in the unit one,
import restrictions scoped to the folder, and a CI job per level.

The cost is that an untested module is no longer obvious from the folder; mirroring the
source layout inside `unit/` gives most of that back, and the explorer answers the rest.

## A test says which part of the product it belongs to by its outer describe

```ts
describe('Triage', () => {
  describe('a dismissed item leaves the lists but is never erased', () => {
    // cases
  });
});
```

The reporter prints the statement and the explorer groups on the outer block — no
plugin, greppable, and it survives changing test framework.

The area is a part of the product someone would name if asked what the app does, not
an entity and not an operation. A dotted `concept.verb` form was tried and dropped:
`item.process`, `item.change` and `item.identity` all look well-formed while naming
objects and functions.

The vocabulary is not a separate list either — it is the Glossary in
`docs/functional-definition.md`, so the words tests use and the words the product is
defined in cannot drift. That also gives the lint rule something real to check, rather
than a shape check like "looks dotted", which is what let the rejected names through.

**Consequence for the coverage explorer.** `poc/coverage-explorer` splits concepts on
the first dotted segment of a describe name; an undotted feature area breaks that, and
its splitting logic needs updating before it is relied on again.

## Seeing what isn't tested

Four separate problems, each with its own answer. Nothing here is a percentage and
nothing is a gate on a number.

| Problem | Answer | What has to be built |
|---|---|---|
| A statement was approved and nobody wrote the test | Todos, which cannot survive a merge | A CI check failing on any remaining todo, plus a review check on removals |
| Code exists that no test executes | Merged coverage, reported as a list of files | Coverage config per level, a merge step |
| A rule exists but is missing a case | Branch coverage: a branch nothing takes is dead code or a missing case | The same run, reporting branch locations |
| Rolling any of it up to "Actions" | File-path patterns per product concept | A patterns file and a check that every source file matches exactly one |

**A statement approved but not written.** An agreed but unbuilt rule is
`describe.todo`; a missing row is `it.todo`. They live in the real test file at the
real level, and no pull request merges with one left, so the branch's first commit is
the approved list and its last has none. One guard is needed, because deleting a todo
is cheaper than implementing it: a removed todo must be matched in the same diff by a
test appearing or a comment saying we chose not to test it. It also forces one case
elsewhere — a rule blocked on an unanswered product question becomes an issue, which
is right, but it means the skill's open-questions output routes to the tracker.

**Code no test executes.** Coverage, used only in the zero direction. The objections in
the coverage options document are objections to coverage as a *target*; none applies to
"nothing runs this file", which is unambiguous and needs a test written to change. The
setting that matters is `coverage.all`, so that files no test imported still appear:

```ts
coverage: {
  provider: 'v8',
  all: true,
  include: ['src/**/*.{ts,tsx}'],
  exclude: ['src/**/*.d.ts', '**/index.ts'],
  reporter: ['json', 'text-summary'],
}
```

Each level runs separately, so reports are merged with `istanbul-lib-coverage` or
`nyc merge`. End-to-end stays out of the union at first: collecting coverage from a
browser and a Worker at once is awkward and that tier is thin by design.

**A rule missing a case.** Branch coverage: if a rule has nine rows and a branch
nothing takes, that branch is dead code or a tenth row. It does not catch every missing
case, since a case can be a different value through the same branch, but it points at
the exact line. Start with v8, check whether the reported locations make sense through
source maps, and switch to istanbul if they do not.

**Rolling up to a product concept.** The naming convention gives it nearly for free
once the action code is `domain/action.ts`, `db/repo/action.ts`, `http/routes/action.ts`
and `apps/web/src/action/**`. What keeps it honest is the check rather than the file:
every source file must match exactly one pattern or CI fails, so a new file matching
nothing forces someone to say where it belongs and a file matching two means the
patterns overlap. That is what makes this different from a hand-maintained list of
concepts — it maps files to groups rather than listing concepts in the abstract.

**The report says, per concept:** files nothing executes, branches nothing takes with
their locations, and file and line counts for scale. Never a percentage.

**What none of this solves:** a rule nobody thought of leaves no trace, and neither
does a missing case through an already-covered branch. Only using the application finds
those.

**Cost:** roughly a day, half of which exists already in `poc/coverage-explorer`.

## What the explorer shows

Rows are parts of the product; columns are counts, not states. That is a change from
the coverage options document, which had each cell holding a state and assumed a part
of the product owes tests at every level. It doesn't — a rule lives at exactly one
level, so Actions owes coverage of its rules, each sitting wherever it belongs.

| | Backend | Frontend | Browser | Contract | Files nothing runs | Branches nothing takes |
|---|---|---|---|---|---|---|
| Actions | 7 | 12 | 2 | n/a | 0 | 4 |
| Dashboards | 1 | 4 | 0 | n/a | 2 | 11 |
| Gmail connector | 3 | 0 | 1 | 2 | 0 | 0 |

- **Browser is its own column, not part of Frontend.** A component test and a browser
  test answer different questions, and the browser one is the only test the strategy
  makes mandatory per capability, so a zero there is the strongest signal on the page.
- **There is no API column yet**, since with one service the API-in-process tests are
  the backend tests. It becomes real the day a second service exists.
- **Contract shows n/a rather than zero** for anything that is not a connector: a
  permanent zero that means nothing is how a report trains you to ignore it.
- **No percentages anywhere**, not even as a secondary number — once one is there it
  becomes the thing you look at, and it is the one number that can be raised without
  proving anything.
- **The counts are the weakest part of the table**, because a count rewards writing
  more rules, which cuts against pruning. They are useful only relatively: Actions has
  seven backend rules and Dashboards has one at a similar size, so look at Dashboards.
  That argues for showing every part of the product on one screen.

**On expand:** a capability's rules, each with its level and the one-clause reason,
plus which branches in its files nothing takes. That is where level choices get
spot-checked.

## Making sure a passing test actually checks something

A test can pass without checking anything: replace
`expect(contents.some(a => a.id === ws.lastActionId)).toBe(expected)` with
`expect(contents).toBeDefined()` and every row passes, the runner prints twenty green
lines, and nothing is checked. One bad line, twenty false statements.

- **A test with no assertion fails.** Configure the runner to fail a test that ran zero
  expectations, and lint a test body with no `expect`. Mechanical, and it costs nothing.
- **Make the rule fail on purpose, once.** Break the code and check the whole table
  goes red; if it stays green the assertion is useless. Once per rule, not per row. For
  new work this is free, because the test is written first and fails on its own.
- **Mutation testing, postponed.** The rules shape makes it more affordable than usual,
  because it can be scoped to one file's rules. Deliberately not built yet.

**Considered and dropped:** a file recording that each test had been seen failing, with
the date. It tells you the test was good the day it was written and nothing about
today. Mutation testing answers the same question every night.

**The gap until then:** nothing catches an assertion weakened after it was written, on
code that already works. Review is meant to, which is exactly the kind of enforcement
the strategy says to replace with something mechanical. Known, accepted for now.

## Two extra checks when a bug gets through

**Temporary, and Michael is not convinced this is worth the effort yet.** Recorded so
the reasoning survives. On top of the regression test the fix already requires:

1. **Look for a "we deliberately chose not to test this" comment** in the file. If
   there is one, read the other skip comments on the same rule and check whether any
   are wrong for the same reason. Example: the action list shows the old title after a
   rename; the skip comment said "one record and one query", the assumption that just
   turned out false, and a nearby comment made the same one. One bug found two.
2. **Ask whether any test we currently run could have caught this**, if someone had
   written it. If no, say so in the pull request, because it means a kind of test is
   missing rather than a test. Example: panels never refreshed on a deployed preview
   and worked locally; nothing we run tests against a deployment.

**Dropped:** a log file of every bug with reason codes. Michael's objections killed it —
you will not remember why months later, patterns will not accumulate at this volume,
and only two codes led to an action, both of which act immediately.

---

# How a statement list is generated

**Moved.** The method worked out here now lives in
[.claude/skills/testing/references/statement-lists.md](../.claude/skills/testing/references/statement-lists.md) —
the passes in order, the collapsing example, the pruning criterion, where a case is
checked, who prunes what, the ways-things-break checklist and the output shape. Rule
wording, level choice and the code shape are in
[.claude/skills/testing/SKILL.md](../.claude/skills/testing/SKILL.md). The worked
result is [statements-issue-36-experiment.md](statements-issue-36-experiment.md).

---

# Still open

## How much Michael actually reviews

The floor is reading the changed statements on each pull request, around ten lines;
below that the system is only as good as a judging agent that has never used the
product. The issue 36 experiment partly answered it: Michael reviewed the *shape* of
the list twice, not the items, and both changes were ones the agent would not have
found. Whether that repeats is the thing to watch, because the value may be
front-loaded. Options still open: an agent flagging statements that restate the
implementation, and reviewing one part of the product a week instead of every pull
request.

## Whether the backend ever moves to feature folders

Not now, and not on size. Revisit when a feature stops being a view over items and
starts owning its own tables. The one thing to avoid is churning the layout twice.

## Rewording a statement

Because the test name is the statement, rewording looks like deleting one statement and
adding another. Acceptable while the diff shows both lines together; revisit if it
starts to hurt.

## The coverage options document needs amending

Its rows come from package globs and layer folders, with the product concept only a
secondary axis for end-to-end tests. This discussion makes the product concept
primary, so the document's stated preference is now the wrong way round.

---

# Considered and dropped

Recorded so they are not relitigated.

- **A hand-maintained list of product concepts.** Replaced by file-path patterns
  checked against the filesystem, and by coverage where a concept has no tests at all.
- **One statement, one test.** Replaced by one rule, one test body, many cases.
- **A separate folder for approved-but-unwritten statements.** Not needed once todos
  live in the real test file and cannot survive a merge.
- **A log file of every bug the tests missed, with reason codes.**
- **A cap on how many statements go to review per part of the product.** The rules
  shape made it unnecessary.
- **Naming the explorer's columns by what they prove** rather than by where the code
  lives. It protected one thing — that a browser test not be lumped in with a component
  test — and a separate Browser column does that inside the simpler grouping.
