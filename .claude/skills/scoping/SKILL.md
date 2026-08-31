---
name: scoping
description: Cockpit's process for sharpening fuzzy requirements, sizing a piece of work as a vertical slice, enumerating the failure modes of anything that changes state it cannot put back, and producing its statement list of test cases - before any code is written. Use whenever starting new feature work, a bug fix, or a larger request, whether or not it will become a GitHub issue. Triggers on the work starting, not on the decision to file an issue.
---

# Scoping a piece of work

Fuzzy scope is where features go wrong, and it goes wrong before a single line of code or a single issue exists. This runs on **any** new piece of work - one built straight into the current session, one filed as a GitHub issue, one split into several - because the sharpening and sizing matter regardless of where the work ends up tracked. Filing a GitHub issue is one possible output of this process, never the trigger for it.

## Process

### 1. Read the inputs

- The request itself: the conversation, the ideas.md entry, the bug report, whatever started this.
- The existing rules for every part of the product this touches: [functional-definition.md](../../../docs/functional-definition.md), [architecture.md](../../../docs/architecture.md), and any topic doc for the area (e.g. [routing-learning.md](../../../docs/routing-learning.md) for routing, [testing-strategy.md](../../../docs/testing-strategy.md) for test placement).
- Open and closed issues/PRs touching the same area (`gh issue list`, `gh pr list`), so this doesn't redo something already decided or already in flight.

### 2. Sharpen fuzzy language before sizing anything

If the request uses a term inconsistently with the docs above, or leaves a product decision unstated, resolve it before drafting. Never guess, and never ask the user something you could resolve yourself by reading the docs or the code.

Use the `grilling` skill's round-based interview (mattpocock-skills): number each open question, give a recommended answer, work the frontier one round at a time, and iterate until nothing about this piece of work's scope is still fuzzy. Skip this step only when the request is already small and unambiguous.

Do not write to `CONTEXT.md` or `docs/adr/` - Cockpit's glossary and decisions live in `functional-definition.md`, `architecture.md`, and the `*-options.md` docs. If grilling resolves something worth recording permanently, add it there, in the section it belongs, in the surrounding doc's own style.

### 3. Size it as a vertical slice

One unit of work is one narrow but complete path through every layer it touches (schema, API, UI, tests, as applicable): demoable or verifiable on its own, and sized to fit a single fresh context window - one sitting.

If the request doesn't fit that, split it into multiple units in dependency order, each declaring what it is **blocked by**. A unit with no unmet blockers can be started immediately; work that frontier first when deciding order. If any of the resulting units will be filed on GitHub, this is also the filing order.

**Exception:** a wide, mechanical refactor (rename a shared symbol, retype a column) whose blast radius fans across the codebase can't be sliced vertically. Sequence it instead as expand (add the new form beside the old) → migrate in batches sized by blast radius, each its own unit blocked by the expand → contract (delete the old form), blocked by every migrate batch.

**When the work grows mid-session, say what it now costs.** Each addition gets judged against the one before it rather than against the original ask, so a run of individually reasonable expansions quadruples a change without anyone deciding to. Name the new total and what it drags behind it — its own tests, another sweep of the documents it falsifies, another review round — so continuing is chosen rather than defaulted into. This is the same sizing question as above, asked again at the moment the answer changes.

### 4. Enumerate the failure modes when state cannot be put back

Most work is safe to get wrong once: a wrong query returns wrong rows until someone fixes it. Some work is not - a migration, a backfill, a destructive script, anything that changes state it cannot put back. For that kind, answer these **before** writing the implementation, and write the answers down as its own header comment, so the thing is built to satisfy them rather than discovering them one at a time:

- **What happens if it fails partway through?** D1 wraps nothing in a transaction: `wrangler d1 migrations apply` runs a file's statements one at a time, and a half-finished file leaves whatever it left.
- **What happens when it runs again?** Work that did not finish is not recorded as finished, so the next deploy repeats it - and a failed migration fails the deploy, so the old code keeps writing in the meantime.
- **What happens to data the new rules reject?** Rows written before a rule existed are the likeliest to break it, and the choice between refusing loudly and dropping them silently has to be made rather than inherited from a default.
- **What does each environment actually do?** Read the deploy workflows, never what seems obvious: preview is re-seeded on every deploy, staging deliberately never is because accumulated state is why it exists, and production is seeded once by hand.
- **What are the distinct windows it can be interrupted in, and what must hold in each?** Enumerate them; "before the swap" and "during the swap" are different questions with different right answers.

Every one of those was answerable up front on "Make the database enforce the schema conventions, not just the callers" (pull request 69), and none was asked. They came back instead as five review rounds and about two hours, four of them data-loss paths in one file, three of those introduced by the fix for the one before: a destructive rebuild that would have emptied staging and production, then a rebuild that could not be re-run, then a cleanup that destroyed the only staged copy, then a stale copy overwriting live writes. The fourth question is the cheapest of the five and skipping it caused the first round and everything downstream - two greps would have settled it.

The answers are also rows for the statement list below: *a re-run after an interruption loses nothing* is a rule with a case per window.

### 5. Generate the statement list

Follow [.claude/skills/testing/references/statement-lists.md](../testing/references/statement-lists.md) exactly - the passes in order, the collapsing step, the pruning criterion, the ways-things-break checklist - using the docs already read in step 1.

This is what tells the build agent (yourself, immediately, or a future agent working a filed issue) which tests to implement, and that is the entire reason to draft it now, while the scope is still small enough to reason about. It does not stay authoritative once building starts: as tests land, the table is superseded by the test names in source, per "Name it after the product" in the testing skill. If this work is going into a GitHub issue, say so at the top of that section, verbatim:

> Drafted for build-time reference. Once implemented, these become test names in source per the testing skill; this list is not maintained afterward.

### 6. Gate before building or filing

Do not proceed - to code or to `gh issue create` - if any of these holds:

- The vertical slice is too big for one sitting - back to step 3.
- The work changes state it cannot put back and its failure modes are not written down - back to step 4. A review round is an expensive way to be told what a checklist asks.
- Any real behaviour this work describes has no row in the statement list - back to step 5. Work with a behaviour nobody wrote a case for is not ready.

## Output

What comes out of this process is a scoped unit of work (or several, in dependency order), its statement list, and - where it changes state it cannot put back - the failure modes its implementation has to satisfy. Two ways that gets used next:

- **Filed as a GitHub issue** - hand off to the `github-issue` skill, which covers only the issue-specific parts: drafting the body template and publishing with `gh issue create`. Do not repeat steps 1-6 there.
- **Built directly in the current session** - proceed straight to implementation. The statement list from step 5 goes straight into the test files as they're written; there is no issue body to draft, but the scope still went through the same sharpening and sizing.
