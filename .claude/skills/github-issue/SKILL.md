---
name: github-issue
description: Cockpit's process for drafting and filing a GitHub issue - sizing it as a vertical slice, sharpening fuzzy requirements against existing docs before writing anything down, and producing the statement list of test cases the testing skill needs. Use whenever turning a conversation, an ideas.md entry or a bug report into one or more GitHub issues, or breaking a larger feature into issues.
---

# Filing a GitHub issue

Issues are how work gets sized and handed to an agent for one sitting. Per [docs/ideas.md](../../../docs/ideas.md), they must be small enough to control what gets tested, but they are not the long-term record - once an issue is built, the source (code, tests, the feature's own docs) is what stays true, per [docs/testing-strategy.md](../../../docs/testing-strategy.md). Filing well means both things at once: a slice small enough to build in one sitting, and a statement list precise enough to tell the build agent exactly what to prove.

## Process

### 1. Read the inputs

- The request itself: the conversation, the ideas.md entry, the bug report, whatever started this.
- The existing rules for every part of the product this touches: [functional-definition.md](../../../docs/functional-definition.md), [architecture.md](../../../docs/architecture.md), and any topic doc for the area (e.g. [routing-learning.md](../../../docs/routing-learning.md) for routing, [testing-strategy.md](../../../docs/testing-strategy.md) for test placement). This is the same "read the existing rules" pass the statement-list method needs - do it once, here, and reuse it in step 5.
- Open and closed issues/PRs touching the same area (`gh issue list`, `gh pr list`), so this doesn't refile something already decided or already in flight.

### 2. Sharpen fuzzy language before sizing anything

If the request uses a term inconsistently with the docs above, or leaves a product decision unstated, resolve it before drafting. Never guess, and never ask the user something you could resolve yourself by reading the docs or the code.

Use the `grilling` skill's round-based interview (mattpocock-skills): number each open question, give a recommended answer, work the frontier one round at a time, and iterate until nothing about this issue's scope is still fuzzy. Skip this step only when the request is already small and unambiguous.

Do not write to `CONTEXT.md` or `docs/adr/` - Cockpit's glossary and decisions live in `functional-definition.md`, `architecture.md`, and the `*-options.md` docs. If grilling resolves something worth recording permanently, add it there, in the section it belongs, in the surrounding doc's own style.

### 3. Size it as a vertical slice

One issue is one narrow but complete path through every layer it touches (schema, API, UI, tests, as applicable): demoable or verifiable on its own, and sized to fit a single fresh context window - one sitting.

If the request doesn't fit that, split it into multiple issues in dependency order, each declaring what it is **blocked by**. An issue with no unmet blockers can be filed and started immediately; work that frontier first when deciding filing order.

**Exception:** a wide, mechanical refactor (rename a shared symbol, retype a column) whose blast radius fans across the codebase can't be sliced vertically. Sequence it instead as expand (add the new form beside the old) → migrate in batches sized by blast radius, each its own issue blocked by the expand → contract (delete the old form), blocked by every migrate batch.

### 4. Draft the issue body

```
## Problem

What's wrong or missing, from the user's perspective.

## What to build

The end-to-end behaviour this issue makes work, from the user's perspective - not a
layer-by-layer implementation list. No file paths or code snippets; they go stale fast.
Exception: a snippet from a prototype that encodes a decision more precisely than prose
can (schema, state machine) - trimmed to the decision, noted as coming from a prototype.

## Blocked by

Issue numbers this depends on, or "None."

## Test cases

[the statement list from step 5, with the framing line from step 5]

## Out of scope / open questions

What this issue deliberately doesn't answer. A question genuinely blocking a rule
belongs here, not as a todo in the eventual test file.
```

### 5. Generate the statement list

Follow [.claude/skills/testing/references/statement-lists.md](../testing/references/statement-lists.md) exactly - the passes in order, the collapsing step, the pruning criterion, the ways-things-break checklist - using the docs already read in step 1. Put the resulting rule tables in the issue's "Test cases" section.

This is what tells the build agent which tests to implement, and that is the entire reason to draft it now, while the scope is still small enough to reason about. It is not meant to outlive the build: once the issue ships, the tables stop being the reference and the test names in source take over. Say so at the top of the section, verbatim:

> Drafted for build-time reference. Once implemented, these become test names in source per the testing skill; this list is not maintained afterward.

### 6. Gate before publishing

Do not file yet if either holds:

- The vertical slice is too big for one sitting - back to step 3.
- Any real behaviour the issue describes has no row in the statement list - back to step 5. An issue with a behaviour nobody wrote a case for is not ready.

### 7. Confirm, then publish

Show the drafted issue(s) before filing. On confirmation, `gh issue create` in dependency order (blockers first) so each "Blocked by" can reference a real issue number. Never close or edit a parent or tracking issue as a side effect of filing the issues under it.
