---
name: github-issue
description: Cockpit's process for turning an already-scoped piece of work into a filed GitHub issue - drafting the body and publishing with gh. Use once the `scoping` skill (sharpening requirements, sizing as a vertical slice, enumerating failure modes where state cannot be put back, generating the statement list) has already run for this work; run `scoping` first if it hasn't.
---

# Filing a GitHub issue

Issues are how work gets sized and handed to an agent for one sitting. Per [docs/ideas.md](../../../docs/ideas.md), they must be small enough to control what gets tested, but they are not the long-term record - once an issue is built, the source (code, tests, the feature's own docs) is what stays true, per [docs/testing-strategy.md](../../../docs/testing-strategy.md).

Sharpening the requirements, sizing the vertical slice, enumerating the failure modes where state cannot be put back, and generating the statement list are not part of this skill - they belong to any new piece of work, filed or not, and live in the [scoping](../scoping/SKILL.md) skill. If that hasn't run yet for this work, run it first. This skill only covers what's specific to the GitHub artifact: the body template and publishing.

## Process

### 1. Draft the issue body

```
## Problem

What's wrong or missing, from the user's perspective.

## What to build

The end-to-end behaviour this issue makes work, from the user's perspective - not a
layer-by-layer implementation list. No file paths or code snippets; they go stale fast.
Exception: a snippet from a prototype that encodes a decision more precisely than prose
can (schema, state machine) - trimmed to the decision, noted as coming from a prototype.

## Failure modes

[only where the work changes state it cannot put back - the answers from scoping step 4:
what must hold if it fails partway, if it runs again, when it meets data the new rules
reject, what each environment actually does, and in every window it can be interrupted.
Omit this section entirely for work that does not. The analysis is the expensive part of
scoping such work; an issue that drops it makes whoever builds this redo it.]

## Blocked by

Issue numbers this depends on, or "None."

## Test cases

[the statement list scoping produced, with the framing line from scoping step 5]

## Out of scope / open questions

What this issue deliberately doesn't answer. A question genuinely blocking a rule
belongs here, not as a todo in the eventual test file.
```

### 2. Confirm, then publish

Show the drafted issue(s) before filing. On confirmation, `gh issue create` in dependency order (blockers first) so each "Blocked by" can reference a real issue number. Never close or edit a parent or tracking issue as a side effect of filing the issues under it.
