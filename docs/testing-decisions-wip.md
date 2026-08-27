# Testing direction: decisions in progress

**Status:** temporary working note, not authoritative. The log of an ongoing
discussion about how testing is driven in this repository. Settled parts move into
`docs/testing-strategy.md` and `docs/coverage-reporting-options.md` when the
discussion ends, the rest become issues, and this file is deleted.

Everything under **Settled** was decided by Michael. Everything under **Still open**
has no decision yet.

## Where the discussion started

Three positions:

1. Development is only fast enough if the agent writes all the test logic.
2. Reading the generated code is not a way to know whether coverage is sufficient.
3. The agent cannot be trusted to pick the right cases or the right level on its own.

Two things follow: there has to be a way to see how good the coverage is without
reading code, and a way to steer the agent on what must be tested without writing
individual test cases. A fourth problem surfaced during the discussion and is arguably
the sharpest: most tests an agent writes cannot be related back to a business case,
because they are named after the mechanism rather than the behaviour.

---

# Settled

## Tests are organised by product concept, not by code structure

"I want to be able to see which tests I have for actions, dashboards." The code
structure cannot answer that and never will, because the API and the web app are
separate applications and an end-to-end test belongs to neither. So the product
grouping is something the test carries, and tooling does the joining.

## The backend stays layered, the frontend groups by feature

No move to feature folders on the backend. Roughly half of it is plumbing that a
feature split would damage: the database schema is one data model with conventions
that hold across every table, the command service is generic over all commands by
design, and the same goes for the database client, the event stream, the app wiring,
tenancy, environment types, jobs, the AI interface and the connector registry.

The half that does split by feature splits inside its layer, as issues arrive:

```
db/schema.ts             stays whole
db/repo/action.ts        action queries
domain/action.ts         pure action logic
http/routes/action.ts    action route definitions
http/command-service.ts  stays whole
```

The architecture's one-directional import rule is unchanged, and it is what makes
unit-testability a structural fact rather than a convention: code under `domain/`
imports nothing from the other layers, and that is enforced.

**The frontend is the opposite case.** The web app is where the file count actually
grows: panel rendering, drag and drop, the assign modal, the triage inbox, capture,
focus and deadline badges, per-screen-size layouts, the offline queue's UI. Those are
real product concepts with their own local state, so they group by concept:

```
apps/web/src/
  panel/      rendering, drag and drop, the assign modal
  inbox/      the triage flow
  action/     the row, the editor, capture
  shared/     api client, query hooks, the event stream, the offline queue
  app/        router, layout, shell
```

Two different problems, two different answers, not a compromise.

**Why the backend answer is the destination and not a stopgap.** Not because the code
is small today. Because of what the finished product looks like: the functional
definition fixes seven concepts (workspace, page, panel, item, association, focus,
deadline) and makes them one shared model, where a panel is a query over items, focus
is a flag on an item and a deadline is a column on one. Feature folders pay off when a
feature owns its data; here `panel/`, `focus/` and `inbox/` would all query the same
table and constantly import each other.

The remaining work reinforces it. Most of what is left is mechanism rather than
features: offline and local-first with queued actions, reconciliation and staleness,
AI enrichment, the triage flow, panel rule configuration, notification routing, auth
and multi-tenancy. Connectors are already separate packages. So the plumbing grows
faster than any feature folder would, which is the opposite of the condition that
would justify inverting.

**What would reopen it.** If panels, focus or the triage inbox stop being views over
items and start owning their own tables and logic. The plain-English panel rules in
issue #35 are the most likely candidate.

## What must be true is written per issue and kept in the source

Plain-English statements of what must be true. Drafted while an issue is being
written, because that is where the scope is small enough to reason about. They do not
stay in the issue: they end up in the source, tied to a feature or component.

The reason they cannot stay in the issue: a statement written against a change goes
stale silently. Deadlines (#37) and goals (#38) both change action behaviour, and
nothing would mark the statements written for #36 as outdated.

## Michael says what matters, a checklist covers the ways things break

Michael's advantage is knowing what the product means, for instance that removing an
action from a panel and deleting it must not be the same thing. His disadvantage is
being exhaustive about failure modes: concurrent edits, retried commands, ordering,
one workspace seeing another's data, empty and huge inputs, partial writes. Those come
from a checked-in checklist. The agent crosses the two and shows the result.

## A statement list is rules with tables underneath, not a flat list

A rule is one behaviour in product language and one test body. Its cases are a table
inside that test, one line each, and what the runner prints per case is the statement.
Nothing is stored separately.

A flat list enumerates the product surface, and many surface behaviours are
consequences of one rule. Fifteen statements about what appears on a panel are one
rule about what a panel contains.

Because the printed case names are the statement list, the test name is the statement.
There is no separate file of statements to keep in sync, which is the thing that
killed this idea every previous time anyone tried it.

## Tests are for confidence, not for covering everything

Michael's words. A case that no plausible implementation could get wrong is padding,
and padding is what makes a list unreviewable. The working version of this is the
pruning pass described further down.

## Tests live in folders per level, inside their package

The testing strategy's directory rule stands as written, no amendment. Unit tests move
out of the source tree.

```
apps/api/tests/{unit,integration}/
apps/web/tests/{unit,service}/
packages/shared/tests/unit/
packages/connectors/*/tests/{unit,contract}/     when connectors land
tests/e2e/                                        at the repo root
```

The folders belong to the package that owns the tests, so filtering by package still
works and a package stays self-contained. End-to-end tests sit at the repo root
because they belong to no package. Contract tests sit with their connector, since each
one is about one third party's recorded responses.

Michael's reason, which is stronger than the co-location argument it replaced: a
folder is a boundary you can police. The testing strategy already asks for network and
filesystem access disabled in the unit runner, and lint rules banning API-client
imports from unit tests. Those are rules about directories; if tests sit next to the
code they degrade into rules about filenames.

What it makes possible: a separate Vitest project per level, with the unit project
given no database binding, no network and no filesystem; import restrictions scoped to
the unit test folder; a CI job per level so a misplaced test is visible.

The cost: an untested module is no longer obvious from looking at the folder.
Mirroring the source layout inside the unit test folder gives most of that back, and
answering that question is what the explorer is for.

The two tests that exist today move out of `apps/api/src/domain/` and
`packages/shared/src/` into their packages' unit folders.

## A test says which part of the product it belongs to by its outer describe

The product concept is the outer block, the rule is the one inside it.

```ts
describe('action.assign', () => {
  describe('a panel shows exactly the actions assigned to it', () => {
    // cases
  });
});
```

The reporter prints `action.assign > a panel shows exactly the actions assigned to
it > an action deleted > does not appear in panel A`. The explorer splits on the first
part. No plugin, no runner-specific feature, greppable, and it survives changing test
framework.

There is no separate list of product concepts to maintain. A lint rule checks only
that the outer describe looks like a dotted name.

## Seeing what isn't tested

Four separate problems, each with its own answer. Nothing here is a percentage and
nothing here is a gate on a number.

| Problem | Answer | What has to be built |
|---|---|---|
| A statement was approved and nobody wrote the test | Todos, which cannot survive a merge | A CI check that fails on any remaining todo, plus a review check on removals |
| Code exists that no test executes | Merged coverage, reported as a list of files | Coverage config per level, a merge step |
| A rule exists but is missing a case | Branch coverage: a branch nothing takes is dead code or a missing case | The same coverage run, reporting branch locations |
| Rolling any of it up to "Actions" | File-path patterns per product concept | A patterns file and a check that every source file matches exactly one |

**A statement approved but not written.** A rule that has been agreed but not built is
`describe.todo('the rule')`; a missing row is `it.todo('the case')`. They live in the
real test file at the real level, so there is no separate pending folder. A pull
request cannot merge with any todo left, so the main branch never has one. A todo is
the branch's own checklist rather than a backlog: the first commit is the approved
list, the last commit has none, and the diff is the burn-down.

That needs one guard, because deleting a todo is cheaper than implementing it. A
removed todo must be matched in the same diff by either a test appearing or a comment
appearing that says we chose not to test it. Without the guard the rule quietly
inverts into "delete the inconvenient statements".

It also forces one case to be handled elsewhere. A rule that cannot be built because a
product question is unanswered can no longer sit as a todo, so it has to become an
issue. That is right, an unanswered product question belongs in the tracker, but it
means the skill's open-questions output routes to issues rather than into the tests.

**Code no test executes.** Coverage, used only in the zero direction. The objections
recorded in the coverage options document are objections to coverage as a target:
satisfiable without asserting anything, rewards testing what is easy to reach. Neither
applies to "nothing runs this file", which is unambiguous and needs a test written to
change.

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

Each level runs separately, so the reports have to be merged before anyone reads them,
with `istanbul-lib-coverage` or `nyc merge`. End-to-end stays out of the union at
first: collecting coverage from a real browser and a Worker at once is awkward and
that tier is thin by design.

**A rule missing a case.** Branch coverage. If a rule has nine rows and the code has a
branch nothing takes, that branch is either dead code or a tenth row. It does not catch
every missing case, since a case can be a different value through the same branch, but
it is specific and it points at the exact line.

The v8 provider maps back to TypeScript through source maps and its branch precision
suffers for it. Start with v8, look at whether the reported branch locations make
sense, and switch to the istanbul provider if they do not.

**Rolling up to a product concept.** The naming convention gives it almost for free:
once the action code is `domain/action.ts`, `db/repo/action.ts`, `http/routes/action.ts`
and `apps/web/src/action/**`, Actions is a file pattern.

What keeps it honest is the check, not the file: every source file must match exactly
one pattern or CI fails. A new file matching nothing forces someone to say where it
belongs; a file matching two means the patterns overlap. That is what makes this
different from a hand-maintained list of product concepts, which was considered and
rejected: it maps files to groups rather than listing concepts in the abstract, so it
can be verified against the filesystem and cannot silently be wrong.

**What the report says per product concept:** files nothing executes, branches nothing
takes with their locations, and file and line counts for scale. Never a percentage.

**What none of this solves,** and it should be said plainly rather than left implied: a
rule nobody ever thought of leaves no trace anywhere, and a missing case that goes
through an already-covered branch leaves none either. Only a bug found by using the
application finds those, which is what the next section is about.

**Cost:** roughly a day, and half exists already. The coverage explorer in `poc/`
already walks the repository and renders a model; this is a new input to it rather
than a new tool.

## What the explorer shows

Rows are parts of the product. Columns are counts, not states.

That is a change from the coverage options document, which proposed each cell holding
a state: met, partial, required and absent, not applicable. That assumed a part of the
product owes tests at every level. It doesn't. A rule lives at exactly one level,
wherever the lowest level that can prove it turns out to be, so "Actions owes an
integration test and a unit test" is not a thing. Actions owes coverage of its rules,
each sitting wherever it belongs.

| | Backend | Frontend | Browser | Contract | Files nothing runs | Branches nothing takes |
|---|---|---|---|---|---|---|
| Actions | 7 | 12 | 2 | n/a | 0 | 4 |
| Dashboards | 1 | 4 | 0 | n/a | 2 | 11 |
| Gmail connector | 3 | 0 | 1 | 2 | 0 | 0 |

**Browser is its own column, not part of Frontend.** A component test and a browser
test answer completely different questions, and the browser one is the only test the
testing strategy makes mandatory per capability. A zero there is the strongest single
signal the page can carry.

**There is no API column yet.** With one service there is no separate system tier, so
the API-in-process tests are the backend tests. It becomes a real column the day a
second service exists.

**Contract shows n/a rather than zero** for anything that is not a connector. A
permanent zero that means nothing is how a report trains you to ignore it.

**No percentages anywhere on the page**, not even as a secondary number. Once one is
there it becomes the thing you look at, and it is the one number in this design that
can be raised without proving anything.

**The counts are the weakest part of the table.** A count rewards writing more rules,
which cuts against the pruning discipline. Six well-pruned rules can be better than
twenty padded ones and the table cannot tell them apart. They are useful only
relatively: Actions has seven backend rules and Dashboards has one, and they are
similar in size, so look at Dashboards. That is an argument for showing every part of
the product on one screen rather than drilling into one at a time.

The last two columns are the ones that mean something on their own. The Dashboards row
above is the one worth looking at, and nothing that makes it bad is in the test counts.

**On expand:** a capability's rules, each with the level it sits at and the one-clause
reason for that level, plus which branches in its files nothing takes. That is where
the level choices get spot-checked.

## Making sure a passing test actually checks something

A test can pass without checking anything. Here is the assertion in the panel contents
rule:

```ts
expect(contents.some(a => a.id === ws.lastActionId)).toBe(expected)
```

If the agent had written `expect(contents).toBeDefined()` instead, every row in the
table passes, the runner prints twenty green lines, the explorer says the rule is
covered, and nothing is being checked. One bad line, twenty false statements.

Two things now, one later.

**A test with no assertion fails.** Configure the runner to fail a test that ran zero
expectations, and add a lint rule for a test body with no `expect`. Catches the
laziest version, costs nothing, and it is mechanical rather than something review has
to notice.

**Make the rule fail on purpose, once.** When a rule is written, break the code and
check the whole table goes red. If it stays green the assertion is useless. Once per
rule, not once per row.

For new work this costs nothing, because the test is written before the code and fails
on its own the first time it runs. The agent states in the pull request that it saw
the rule fail before the implementation landed.

**Mutation testing, postponed.** A tool that changes the code on purpose, runs the
tests and reports which ones did not notice. Same idea as breaking it by hand, done
mechanically and repeatedly. The rules shape makes it more affordable than usual,
because it can be scoped: mutate one file, run only that part of the product's rules,
and the number of mutants is proportional to that file rather than the codebase.
Deliberately not built yet.

**What was considered and dropped:** a file recording that each test had been seen
failing, with the date. It tells you the test was good the day it was written and
nothing about today. If someone weakens an assertion six months later the file still
says the test was fine in March. Mutation testing answers the same question every
night, so the file is a weaker signal that also costs more to maintain.

**The gap until mutation testing exists:** nothing catches an assertion weakened after
it was written, on code that already works. Review is meant to, which is exactly the
kind of enforcement the testing strategy says to replace with something mechanical.
Known, accepted for now.

## Two extra checks when a bug gets through

**Temporary, and Michael is not convinced this is worth the effort yet.** Recorded so
the reasoning survives, not because it is agreed. Revisit after it has been tried a
few times.

When a bug is found that the tests did not catch, the fix already has to include a
test for it. Two things get done on top of that:

**One.** Look in the test file for a comment saying we deliberately chose not to test
this. If there is one, read the other "chose not to test" comments on the same rule
and check whether any of them are wrong for the same reason.

**Two.** Ask whether any test we currently run could have caught this, if someone had
written it. If the answer is no, say so in the pull request, because it means we are
missing a kind of test rather than a test.

An example of the first. The action list shows the old title after a rename. The agent
fixes the query and adds the case. While there it sees a comment saying "we skipped
checking the title in the action list, one record and one query", which is the
assumption that just turned out to be false. So it reads the nearby skip comments and
finds another with the same assumption, also now wrong, and fixes it in the same pull
request. One bug found two.

An example of the second. Panels never refresh on the deployed preview URL, and work
locally. Nothing we run tests against a deployment, so no test anyone could have
written would have found it. The pull request says so, and the answer is either a
smoke check after deploying or writing down that we are living with it.

**What was dropped and why.** An earlier version of this kept a log file of every bug
with a reason code, and watched for patterns. Michael's objections killed it: you will
not remember why months later, patterns will not accumulate at this volume, and most
of the reason codes led nowhere anyway. Only two led to an action, and both act
immediately, so the log was doing nothing.

---

# How a statement list is generated (the material for the skill)

Worked out by generating and pruning the list for issue #36. The result is
`statements-issue-36-experiment.md`; this is the method behind it. Every rule below
carries an example, because the abstract version of this guidance produced a bad list
twice.

## The passes, in order

1. **Read the inputs.** The issue, its comments, the issues it depends on, and the
   existing rules for every part of the product it touches. The third input is what
   stops each issue writing a fresh list with nothing marking older rules as outdated.
2. **Extract the surface.** Every behaviour the issue literally describes. Mechanical,
   long, and not the output.
3. **Collapse the surface into rules.** Find the rule that several surface behaviours
   are consequences of, and write the rule instead.
4. **Build each rule's table.** The situations that exercise it, and the places each
   situation is checked against.
5. **Prune.**
6. **Choose a level per rule** with a one-clause reason, following the testing
   strategy's rule that a test goes at the lowest level that can prove the behaviour.
7. **Add the ways-things-break checklist as rules**, not as cases sprinkled through
   the feature rules.
8. **List what the issue does not answer**, moving anything that is really a missing
   case into the rule where it belongs.

Pass 3 is the one an agent skips, because the issue is written surface-first. It has to
be done deliberately.

## Pass 3, collapsing: an example

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

## Writing a rule

Product language. No function names, no table names, no HTTP status codes as the
subject.

| Bad | Why |
|---|---|
| `commandService` dedupes by `commandId` | Names the implementation. Unreadable as intent. |
| The panel contents query filters on assignment and excludes deleted rows | True, and still a mechanism statement. This is the trap on the other side of collapsing: collapse far enough and you stop describing the product. |
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

The same shape works on the frontend: "a command that fails puts the screen back"
absorbs every command, rather than one rule per command.

## The pruning criterion

Cut a case when either holds.

**No distinct path.** The cases read the same data through the same query with the
same parameters.

> Cut: "an edited title shows in the action list." There is one action record and one
> list query, so this is not a second thing that could be wrong.

**Already exercised.** Something else runs the same code and would go red if it broke.

> Cut: "when two changes race, the later one wins." That is implemented in one
> function which already has a unit test.

"It is obvious" and "it would be hard to get wrong" are not reasons on their own.
Require one of the two above, because the second is checkable and the feeling is not.

**Do not over-prune.** The failure mode of a pruning rule is cutting a case that looks
like a duplicate but runs different code.

> Keep: "a deleted action is gone from the action list." The action list is a
> different query with a different filter, and forgetting the deleted-row filter in
> one read path while getting it right in another is one of the most common ways this
> breaks.

The signal is always the same question: is there a distinct query, branch or decision
behind this case? If yes, keep it however obvious it looks.

## Where a case is checked

Places count as separate only when they are separate queries with different filters.

> Bad: check all twelve situations against all five of panel A, panel B, panel C, the
> Inbox and the action list. Sixty checks, most of them the same query twice.
>
> Good: check the assignment situations against the panels involved and the Inbox,
> which are complementary filters, and check the action list only on the situations
> that change what it returns, which is deletion and workspace.

## Who prunes what

Whether a plausible implementation could get it wrong is often a product fact only the
human has, so those cuts happen at review. Both of the shape changes in the issue #36
experiment came from Michael, not the agent.

Whether two cases share a code path is an implementation fact, so those cuts happen
during the build, by the agent, and are reported in the pull request. Mark them in the
list when the list is written:

> moved from A to B → on B only *(cut at build time if a move is a remove plus an add
> rather than its own command)*

## The ways-things-break checklist

Crossed with the product rules. Each becomes a rule with a growing table, never cases
sprinkled through the feature rules:

- two people, or two tabs, doing something at once
- the same command sent twice
- one workspace seeing another's data
- empty and very large collections
- something failing halfway through
- invalid input

## Choosing a level

The lowest level that can prove the behaviour. Escalating because a unit test would
prove nothing is that rule working, not an exception to it.

The reason has to name what stops a lower level proving it.

| Bad reason | Good reason |
|---|---|
| Integration, because it is integration-like | Integration, because a panel's contents are a query, so this only holds against a real database |
| End to end, because it is user-facing | End to end, because the drag only exists in a browser |

**Frontend rules are about the UI's own behaviour and its wiring, never a restatement
of a backend rule.**

> Bad: a browser test for "removing an action from a panel leaves it on the other
> panels". That is a backend rule being re-proved in a browser.
>
> Good: "the remove control sends a remove for this panel." Plus, separately, one
> browser walk per capability proving the whole thing works at all.

Expensive levels are kept thin by a budget, not by a ban on overlap. A walk that
crosses a rule the integration tests already cover is fine. Twelve browser cases for
twelve validation rules is not.

## What a rule looks like as code

One body, tables as data. Adding a situation is one line.

```ts
describe('a panel shows the actions assigned to it, the Inbox shows the rest', () => {
  const situations = [
    { name: 'created on a panel',          act: a => a.createOn('A'),             A: true,  inbox: false },
    { name: 'created from the add button', act: a => a.create(),                  A: false, inbox: true  },
    { name: 'assigned to a panel',         act: a => a.create().assign('A'),      A: true,  inbox: false },
    { name: 'removed from its only panel', act: a => a.createOn('A').remove('A'), A: false, inbox: true  },
    { name: 'deleted',                     act: a => a.createOn('A').delete(),    A: false, inbox: false },
  ];

  describe.each(situations)('an action $name', (s) => {
    let ws;
    beforeEach(async () => {
      ws = await seedWorkspace({ panels: ['A', 'B'] });
      await s.act(ws.actions);
    });

    it.each([
      { where: 'panel A',   read: () => panelContents(ws, 'A'), expected: s.A },
      { where: 'the Inbox', read: () => inboxContents(ws),      expected: s.inbox },
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

## What the output looks like

The rule, its cases with expected outcomes, where each is checked, the level with its
reason, and a separate table of what was cut and why. Keep the cut list: it is how the
pruning criterion gets checked and improved, and it is the part a reviewer can
disagree with fastest.

Counts at the end, so the review effort is visible before it is spent.

## A gap in this guidance

Every example here comes from issue #36, so they are all about one entity with panels
and assignments. An agent applying this to a connector issue or the offline queue has
nothing analogous to look at, and those are shaped differently. Add a second worked
example from a mechanism-heavy issue once one exists, rather than inventing one now.

---

# Still open

## How much Michael actually reviews

The floor is reading the changed statements on each pull request, which is around ten
lines. Below that the system is only as good as a judging agent that has never used
the product.

The issue #36 experiment partly answered this: Michael reviewed the *shape* of the
list twice, not the items, and both shape changes were things the agent would not have
found. Whether that repeats on the next issue is the thing to watch, because the value
may be front-loaded.

Options still on the table: an agent that flags statements which restate the
implementation rather than the product, and reviewing one part of the product a week
instead of every pull request.

## Whether the backend ever moves to feature folders

Not now, and not on size. Revisit when a feature stops being a view over items and
starts owning its own tables and logic. The one thing to avoid is churning the layout
twice.

## Rewording a statement

Because the test name is the statement, rewording one looks like deleting a statement
and adding a different one. Acceptable while the pull request diff shows both lines
next to each other, so a reword is readable as a reword. Revisit if it starts to
hurt.

## The coverage options document needs amending

Its rows come from package globs and layer folders, with the product concept only a
secondary axis for end-to-end tests. This discussion makes the product concept the
primary one. Both still exist, but the document's stated preference is now the wrong
way round.

---

# Considered and dropped

Recorded so they are not relitigated.

- **A hand-maintained list of product concepts.** Replaced by file-path patterns
  checked against the filesystem, and by coverage for the case where a concept has no
  tests at all.
- **One statement, one test.** Written before the rules-and-tables shape. Replaced by
  one rule, one test body, many cases.
- **A separate folder for approved-but-unwritten statements.** Not needed once todos
  live in the real test file and cannot survive a merge.
- **A log file of every bug the tests missed, with reason codes.** Killed by Michael's
  objections: you will not remember why months later, patterns will not accumulate at
  this volume, and most of the codes led nowhere.
- **A cap on how many statements go to review per part of the product.** The rules
  shape made it unnecessary: twenty rules for an issue the size of #36 is not a number
  that needs capping.
- **Naming the explorer's columns by what they prove** rather than by where the code
  lives. It was protecting one thing, that a browser test not be lumped in with a
  component test, and splitting Browser into its own column does that inside the
  simpler grouping.
