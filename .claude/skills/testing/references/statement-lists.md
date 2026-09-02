# Generating a statement list

A statement list is what gets reviewed before any test is written: the rules a piece of work must make true, in product language, with the cases that exercise each one. It is drafted while the scope is still small enough to reason about, and it does not stay in the issue — it ends up in the source as test names, per "Name it after the product" in SKILL.md, because a statement written against a change goes stale silently.

The method was worked out on "Render actions in panels, backed by one shared action list" (issue 36); the result is [docs/statements-issue-36-experiment.md](../../../../docs/statements-issue-36-experiment.md). The abstract version of this guidance produced a bad list twice, so every rule here carries its example.

## The passes, in order

1. **Read the inputs.** The issue, its comments, the issues it depends on, and **the existing rules for every part of the product it touches** — the third is what stops each issue writing a fresh list with nothing marking older rules as outdated.
2. **Extract the surface.** Every behaviour the issue literally describes. Mechanical, long, and not the output.
3. **Collapse the surface into rules.** Find the rule those behaviours are consequences of, and write the rule instead.
4. **Build each rule's table**: the situations that exercise it, and the places each is checked against.
5. **Prune.**
6. **Choose a level per rule**, with a one-clause reason, per "Pick the level" in SKILL.md.
7. **Add the ways-things-break checklist as rules**, not as cases sprinkled through the feature rules.
8. **List what the work does not answer**, moving anything that is really a missing case into the rule where it belongs.

**Pass 3 is the one that gets skipped**, because issues are written surface-first. Do it deliberately.

## Pass 3, collapsing

Issue 36 produced this surface, among others:

- an action created from a panel appears on that panel
- an action created from the dashboard button appears in the Inbox
- assigning an action to a panel takes it out of the Inbox
- an action assigned to two panels appears on both
- removing an action from one of two panels leaves it on the other
- removing an action from its only panel returns it to the Inbox
- deleting an action removes it from every panel
- an action never appears in another workspace

All eight are consequences of one thing:

> **A panel shows exactly the actions assigned to it, and the Inbox exactly the ones assigned to no panel.**

with the eight as rows in its table. In the real list that rule absorbed fifteen.

**The test for a collapse:** if the rule changed, would every case under it change too? A case that would survive belongs to a different rule.

The trap on the other side is collapsing until you stop describing the product: "The panel contents query filters on assignment and excludes deleted rows" is true and is still a mechanism statement.

## The pruning criterion

Cut a case when either holds.

**No distinct path** — same data, same query, same parameters.

> Cut: "an edited title shows in the action list." One record, one list query.

**Already exercised** — something else runs the same code and would go red if it broke.

> Cut: "when two changes race, the later one wins." One function, already unit-tested.

"It is obvious" and "it would be hard to get wrong" are not reasons on their own: require one of the two above, because they are checkable and the feeling is not.

**Do not over-prune.** The failure mode is cutting a case that looks like a duplicate but runs different code.

> Keep: "a deleted action is gone from the action list." A different query with a different filter, and forgetting the deleted-row filter in one read path while getting it right in another is one of the commonest ways this breaks.

The signal: is there a distinct query, branch or decision behind this case? If yes, keep it however obvious it looks.

## Where a case is checked

Places count as separate only when they are separate queries with different filters.

> Bad: all twelve situations against panel A, panel B, panel C, the Inbox and the action list — sixty checks, most the same query twice.
>
> Good: assignment situations against the panels involved and the Inbox, which are complementary filters; the action list only on the situations that change what it returns, which is deletion and workspace.

## Who prunes what

- **Whether a plausible implementation could get it wrong** is often a product fact only Michael has, so those cuts happen at review. Both shape changes in the issue 36 experiment came from him.
- **Whether two cases share a code path** is an implementation fact, so those cuts happen during the build, by the agent, and are reported in the pull request. Mark them when the list is written:

> moved from A to B → on B only *(cut at build time if a move is a remove plus an add rather than its own command)*

## The ways-things-break checklist

Michael says what matters; this covers how things break. Cross the two. Each item becomes its own rule with a growing table:

- two people, or two tabs, doing something at once
- the same command sent twice
- one workspace seeing another's data
- empty and very large collections
- something failing halfway through
- invalid input

## The output

Per rule: the rule in product language, its cases with expected outcomes, where each is checked, and the level with its one-clause reason. Then a **separate table of what was cut and why** — it is how the pruning criterion gets checked, and the part a reviewer can disagree with fastest. Mark cases inferred rather than stated. Counts at the end, so the review effort is visible before it is spent.

Anything genuinely unanswered is an open question routed to the tracker, not a todo in a test file.

## Known gap

Every example here comes from issue 36, so they all concern one entity with panels and assignments. A connector issue or the offline queue is shaped differently and has nothing analogous to look at. Add a second worked example from a mechanism-heavy issue once one exists.
