---
name: github-issue
description: Cockpit's ticket template and the gh commands to create and update one - used by `scoping` to file the ticket, `technical-design` to add its sections, and `slicing` to finish it or split it into child tickets under a parent. Holds the body template and publishing only; never decides what goes in a section.
---

# The ticket

Issues size work for one sitting. They are not the long-term record: once an issue is built, the source — code, tests, the feature's own docs — is what stays true, per [docs/testing-strategy.md](../../../docs/testing-strategy.md).

One ticket carries a piece of work from `scoping` through `technical-design` to `slicing`, each adding its own sections, so what one skill produces the next finds on the ticket and not in a session that may have ended. [scoping](../scoping/SKILL.md) decides the Problem and What to build, [technical-design](../technical-design/SKILL.md) the design and failure modes, and [slicing](../slicing/SKILL.md) the units, models and test cases; none is repeated here. This skill covers only the body template and the `gh` commands.

## Length

**An issue is a brief, not an essay.** Whoever builds it reads it inside a context budget, so every sentence that does not change what gets built is a cost paid on every read. Follow the "Writing" rules in [CLAUDE.md](../../../CLAUDE.md), and specifically:

- **Problem and What to build: three or four sentences each.** State the behaviour and the reason it is wanted. Evidence — a log count, a failing run, a measurement — is one sentence with the number in it, not a reconstruction of how it was found.
- **Give a rejected explanation one line.** "Not the `writeSSE` calls: Hono's `StreamingApi.write()` discards write errors." The reader needs the conclusion and the fact behind it, not the investigation.
- **Cut anything the builder will discover in the first ten minutes.** Speculation about where a bug lives belongs in the issue only where it saves real time, and then as a list of candidates, not prose.
- **Open questions are bullets, one or two sentences each.**

A 400-word issue is normal, and past 800 words something is being explained twice. That budget counts the prose; the **Test cases** section is a statement list whose length is governed by the pruning criterion in `statement-lists.md`, not by a word count, and it is never trimmed to meet this rule.

## Process

### 1. The body, by who writes what

```
## Problem                      <- scoping

What's wrong or missing, from the user's perspective.

## What to build                <- scoping

The end-to-end behaviour this ticket makes work, from the user's perspective - not a
layer-by-layer implementation list. No file paths or code snippets; they go stale fast.
Exception: a snippet from a prototype that encodes a decision more precisely than prose
can (schema, state machine) - trimmed to the decision, noted as coming from a prototype.

## Out of scope / open questions   <- scoping

What this deliberately doesn't cover, and questions whose answer wouldn't change the diff
either way - record these here, never as a todo in the eventual test file. A question the
gate of `scoping` or `technical-design` would refuse belongs there, not here.

## Technical design             <- technical-design

[The decisions, three lines each. "No design needed: <the trigger check in one line>" where
it found nothing; omit the section only for a bug fix.]

## Failure modes                <- technical-design

[One line per question from technical-design's "Enumerate the failure modes when state cannot
be put back" step. Omit the section entirely where the work changes nothing it cannot put
back.]

## Blocked by                   <- slicing

Issue numbers this depends on, or "None."

## Model                        <- slicing

[Always: `Recommended: opus`, `Recommended: sonnet` or `Recommended: haiku`, with slicing's
one-line reason.]

## Test cases                   <- slicing

[the statement list slicing produced, with the framing line from slicing's "Generate the
statement list" step]
```

A **child** ticket opens with "Part of #N <parent title>" and carries only its own slice of each section: its What to build, the design points and failure modes that apply to it, and its own Blocked by, Model and Test cases. A **parent** keeps Problem, What to build, Technical design and Failure modes, drops Test cases, and gains the two sections below.

```
## Children                     <- slicing

One line per child: number, title, model, blocked by.

## Coverage                     <- slicing

One row per rule from What to build and per line of Failure modes, naming the one child that owns it.
```

### 2. Create, update, split

- **File** (scoping): `gh issue create` with Problem, What to build and Out of scope, and the `unsliced` label, creating the label first if the repository has none. Show the draft and file on confirmation.
- **Add** (technical-design): `gh issue edit <number> --body-file` with the design sections added and everything else as it was.
- **Finish** (slicing, one unit): edit the same ticket to add Blocked by, Model and Test cases, and remove `unsliced`.
- **Split** (slicing, several units): `gh issue create` the children in dependency order, blockers first, so each "Blocked by" names a real number; then edit the original into the parent and remove `unsliced` from it. Children never carry `unsliced`. Never close or edit any other parent or tracking ticket as a side effect.
