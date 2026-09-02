---
name: github-issue
description: Cockpit's process for turning an already-scoped piece of work into a filed GitHub issue - drafting the body and publishing with gh. Use once the `scoping` skill (sharpening requirements, sizing as a vertical slice, enumerating failure modes where state cannot be put back, generating the statement list) has already run for this work; run `scoping` first if it hasn't.
---

# Filing a GitHub issue

Issues size work for one sitting. They are not the long-term record: once an issue is built, the source — code, tests, the feature's own docs — is what stays true, per [docs/testing-strategy.md](../../../docs/testing-strategy.md).

Sharpening, sizing, failure modes and the statement list belong to the [scoping](../scoping/SKILL.md) skill and are not repeated here. This skill covers only the body template and publishing.

## Length

**An issue is a brief, not an essay.** Whoever builds it reads it inside a context budget, so every sentence that does not change what gets built is a cost paid on every read. Follow the "Writing" rules in [CLAUDE.md](../../../CLAUDE.md), and specifically:

- **Problem and What to build: three or four sentences each.** State the behaviour and the reason it is wanted. Evidence — a log count, a failing run, a measurement — is one sentence with the number in it, not a reconstruction of how it was found.
- **Give a rejected explanation one line.** "Not the `writeSSE` calls: Hono's `StreamingApi.write()` discards write errors." The reader needs the conclusion and the fact behind it, not the investigation.
- **Cut anything the builder will discover in the first ten minutes.** Speculation about where a bug lives belongs in the issue only where it saves real time, and then as a list of candidates, not prose.
- **Open questions are bullets, one or two sentences each.**

A 400-word issue is normal, and past 800 words something is being explained twice. That budget counts the prose; the **Test cases** section is a statement list whose length is governed by the pruning criterion in `statement-lists.md`, not by a word count, and it is never trimmed to meet this rule.

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

[One line per question from scoping's "Enumerate the failure modes when state cannot be put
back" step. Omit the section entirely where the work changes nothing it cannot put back;
where it does, an issue that drops it makes whoever builds this redo the expensive part of
scoping.]

## Blocked by

Issue numbers this depends on, or "None."

## Test cases

[the statement list scoping produced, with the framing line from scoping's "Generate the
statement list" step]

## Out of scope / open questions

What this issue deliberately doesn't answer. A question genuinely blocking a rule
belongs here, not as a todo in the eventual test file.
```

### 2. Confirm, then publish

Show the drafted issue(s) before filing. On confirmation, `gh issue create` in dependency order (blockers first) so each "Blocked by" can reference a real issue number. Never close or edit a parent or tracking issue as a side effect of filing the issues under it.
