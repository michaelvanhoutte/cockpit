---
name: scoping
description: Cockpit's process for sharpening fuzzy requirements, sizing a piece of work as a vertical slice, and producing its statement list of test cases - before any code is written. Use whenever starting new feature work, a bug fix, or a larger request, whether or not it will become a GitHub issue. Triggers on the work starting, not on the decision to file an issue.
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

### 4. Generate the statement list

Follow [.claude/skills/testing/references/statement-lists.md](../testing/references/statement-lists.md) exactly - the passes in order, the collapsing step, the pruning criterion, the ways-things-break checklist - using the docs already read in step 1.

This is what tells the build agent (yourself, immediately, or a future agent working a filed issue) which tests to implement, and that is the entire reason to draft it now, while the scope is still small enough to reason about. It does not stay authoritative once building starts: as tests land, the table is superseded by the test names in source, per "Name it after the product" in the testing skill. If this work is going into a GitHub issue, say so at the top of that section, verbatim:

> Drafted for build-time reference. Once implemented, these become test names in source per the testing skill; this list is not maintained afterward.

### 5. Gate before building or filing

Do not proceed - to code or to `gh issue create` - if either holds:

- The vertical slice is too big for one sitting - back to step 3.
- Any real behaviour this work describes has no row in the statement list - back to step 4. Work with a behaviour nobody wrote a case for is not ready.

## Output

What comes out of this process is a scoped unit of work (or several, in dependency order) and its statement list. Two ways that gets used next:

- **Filed as a GitHub issue** - hand off to the `github-issue` skill, which covers only the issue-specific parts: drafting the body template and publishing with `gh issue create`. Do not repeat steps 1-5 there.
- **Built directly in the current session** - proceed straight to implementation. The statement list from step 4 goes straight into the test files as they're written; there is no issue body to draft, but the scope still went through the same sharpening and sizing.
