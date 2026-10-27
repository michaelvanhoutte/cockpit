---
name: github-issue
description: Cockpit's ticket template and the gh commands to create and update one - used by `scoping` to file the ticket, `engineering-plan` to add its design sections and then to finish it or split it into child tickets under a parent. Holds the body template and publishing only; never decides what goes in a section.
---

# The ticket

Issues size work for one sitting. They are not the long-term record: once an issue is built, the source — code, tests, the feature's own docs — is what stays true, per [docs/testing-strategy.md](../../../docs/testing-strategy.md).

One ticket carries a piece of work from `scoping` through the two phases of `engineering-plan`, each adding its own sections, so what one skill produces the next finds on the ticket and not in a session that may have ended. [scoping](../scoping/SKILL.md) decides the Problem and What to build, and [engineering-plan](../engineering-plan/SKILL.md) the design, failure modes, units, models and test cases; none is repeated here. This skill covers only the body template and the `gh` commands.

## Length

**An issue is a brief, not an essay.** Whoever builds it reads it inside a context budget, so every sentence that does not change what gets built is a cost paid on every read. Follow the "Writing" rules in [CLAUDE.md](../../../CLAUDE.md), and specifically:

- **Problem and What to build: three or four sentences each.** State the behaviour and the reason it is wanted. Evidence — a log count, a failing run, a measurement — is one sentence with the number in it, not a reconstruction of how it was found.
- **Give a rejected explanation one line.** "Not the `writeSSE` calls: Hono's `StreamingApi.write()` discards write errors." The reader needs the conclusion and the fact behind it, not the investigation.
- **Cut anything the builder will discover in the first ten minutes.** Speculation about where a bug lives belongs in the issue only where it saves real time, and then as a list of candidates, not prose.
- **Open questions are bullets, one or two sentences each.**

A 400-word issue is normal, and past 800 words something is being explained twice. That budget counts the prose; the **Test cases** section is a statement list whose length is governed by the pruning criterion in `statement-lists.md`, not by a word count, and it is never trimmed to meet this rule.

## Title

**A title carries three things**, because a reader scanning the list has only the title to tell what a ticket is about and why it exists:

- **Where it belongs:** the feature, page or skill, in the product's own words. A child names its parent's feature, since its number says nothing.
- **What is wrong, slow or missing:** the reason, not only the fix. A bug's title gives the symptom and where it shows.
- **What changes:** one change, in plain words. No shorthand only the body defines.

**Name a skill or file only when it is the thing changed**, and then say what it does.

| Before | After |
|---|---|
| Size the per-run budgets and the spent-allowance path for Workers Paid | Code is still sized to Workers Free limits though the account is on Workers Paid: raise or keep the per-run budgets and the spent-allowance path |
| Open a Workspace without its finished Items | Opening a Workspace slows as finished Items pile up: open it without them |
| Cc or Bcc your Cockpit address to wait for a reply, and chase to restart | Email capture: make a Cc or Bcc'd mail an Item waiting for a reply, and restart the wait when a chasing mail arrives |
| Ask which session-review rules to write before drafting any, and explain each in plain words | Make session-review ask which process rules to write before drafting any, and explain each in plain words |

**Before filing, read the title alone** and check that someone who has not seen the ticket could say what it is about and why. Length is not the test.

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
gate of `scoping` or `engineering-plan` would refuse belongs there, not here.

## Technical design             <- engineering-plan (design)

[The request-path rows, one per action, then the decisions, three lines each. "No design
needed: <the trigger check in one line>" with the rows where it found nothing; omit the
section only for a bug fix that is not about speed.]

## Failure modes                <- engineering-plan (design)

[One line per question from engineering-plan's "Enumerate the failure modes when state cannot
be put back" step. Omit the section entirely where the work changes nothing it cannot put
back.]

## Blocked by                   <- engineering-plan (slicing)

Issue numbers this depends on, or "None."

## Model                        <- engineering-plan (slicing)

[Always: `Recommended: opus`, `Recommended: sonnet` or `Recommended: haiku`, with engineering-plan's
one-line reason.]

## Test cases                   <- engineering-plan (slicing)

[the statement list engineering-plan produced, with the framing line from its "Generate the
statement list" step]
```

A **child** ticket opens with "Part of #N <parent title>" and carries only its own slice of each section: its What to build, the design points and failure modes that apply to it, and its own Blocked by, Model and Test cases. A **parent** keeps Problem, What to build, Technical design and Failure modes, drops Test cases, and gains the two sections below.

```
## Children                     <- engineering-plan (slicing)

One line per child: number, title, model, blocked by.

## Coverage                     <- engineering-plan (slicing)

One row per rule from What to build and per line of Failure modes, naming the one child that owns it.
```

### 2. Create, update, split

- **File** (scoping): `gh issue create` with Problem, What to build and Out of scope, and the `unsliced` label, creating the label first if the repository has none. Check the title against the Title section first. Show the draft and file on confirmation.
- **Add** (engineering-plan, design): `gh issue edit <number> --body-file` with the design sections added and everything else as it was.
- **Finish** (engineering-plan, slicing, one unit): edit the same ticket to add Blocked by, Model and Test cases, and remove `unsliced`.
- **Split** (engineering-plan, slicing, several units): `gh issue create` the children in dependency order, blockers first, so each "Blocked by" names a real number, each title checked against the Title section; then edit the original into the parent and remove `unsliced` from it. Children never carry `unsliced`. Never close or edit any other parent or tracking ticket as a side effect.
