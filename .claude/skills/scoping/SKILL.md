---
name: scoping
description: Cockpit's process for deciding whether a piece of work has to be seen before it is scoped, sharpening fuzzy requirements, sizing it as a vertical slice, enumerating the failure modes of anything that changes state it cannot put back, and producing its statement list of test cases - before any code is written. Use whenever starting new feature work, a bug fix, or a larger request, whether or not it will become a GitHub issue. Triggers on the work starting, not on the decision to file an issue.
---

# Scoping a piece of work

Fuzzy scope is where features go wrong, before a line of code or an issue exists. This runs on **any** new piece of work — built straight into this session, filed as an issue, or split into several. Filing an issue is one possible output, never the trigger.

## Process

### 1. Read the inputs

- The request itself: the conversation, the `ideas.md` entry, the bug report.
- The existing rules for every part of the product this touches: [functional-definition.md](../../../docs/functional-definition.md), [architecture.md](../../../docs/architecture.md), and any topic doc for the area (e.g. [routing-learning.md](../../../docs/routing-learning.md), [testing-strategy.md](../../../docs/testing-strategy.md) for test placement).
- Open and closed issues and pull requests touching the same area (`gh issue list`, `gh pr list`), so this doesn't redo something already decided or in flight.

### 2. Decide whether it has to be seen first

Prose that reads fine fails on contact — two designs agreed in discussion over the new-user onboarding work were rejected the moment they were on screen. So where the work puts a surface in front of the user, decide here, once, which of three things it needs.

| | Answers | Costs | Take it when |
|---|---|---|---|
| **Nothing** | — | — | the default: the surface exists and the change follows a pattern already settled in the app |
| **A design canvas** (`design` skill) | what it should look like, with the arrangements you rejected beside it | minutes, no branch | the surface is new and more than one layout is defensible |
| **A POC** on a branch in the real app | whether it survives contact with what is already there | a branch and a sitting, thrown away | the doubt is about affordance, interaction, or fit with existing behaviour — none of which a mockup shows |

**Escalate only against a named doubt.** Write down the question the artifact will answer; if you cannot write one, take *Nothing*.

**The request wins over the table, and neither answer is silent.** "Just scope it" or "mock it first" settles it and is not asked again; otherwise this is question 1 of the round in step 3, carrying your recommendation. Never start a POC unannounced, and never skip the question on a surface nobody has seen.

**Challenge the result rather than presenting it**: name what you chose and what you rejected, and ask about the concept and its presentation separately — the concept is usually right and the presentation is what comes back.

**A POC is throwaway**: in the real app rather than `poc/`, no tests, no docs. Save the diff outside git before reverting, because what it found is an input to step 3 and rows in step 6.

### 3. Sharpen fuzzy language before sizing anything

Resolve any term used inconsistently with those docs, and any unstated product decision, before drafting. Never guess, and never ask the user what you could answer by reading the docs or the code.

Use the `grilling` skill's round-based interview (mattpocock-skills): number each open question, give a recommended answer, work one round at a time until nothing about the scope is fuzzy. Skip only when the request is already small and unambiguous.

Do not write to `CONTEXT.md` or `docs/adr/` — Cockpit's glossary and decisions live in `functional-definition.md`, `architecture.md` and the `*-options.md` docs. Record anything permanent there, in that document's own style.

### 4. Size it as a vertical slice

One unit of work is one narrow but complete path through every layer it touches (schema, API, UI, tests): demoable on its own, and sized to fit a single fresh context window.

**A context window is one measure of size, and elapsed time is the other.** `main` merges roughly one pull request an hour, and a branch pays for every one that lands while it is open — twelve landed under "Edit an item's title and description on a form of its own" (pull request 163) in fifteen hours, costing six merges that each re-resolved the Item model, capture and the row, and a full re-run of three test tiers apiece. Ask whether the slice can be *merged today*, not only whether it fits a sitting; where it cannot, split it again.

If the request doesn't fit, split it into units in dependency order, each declaring what it is **blocked by**. Work the frontier of unblocked units first; if they get filed, that is also the filing order.

**Exception:** a wide mechanical refactor (rename a shared symbol, retype a column) can't be sliced vertically. Sequence it as expand (add the new form beside the old) → migrate in batches, each its own unit blocked by the expand → contract (delete the old form), blocked by every batch.

**State a recommended model beside each unit, only where the session default is wrong for it:**

- `opus` — the unit trips step 5 below (it changes state it cannot put back, so a wrong call costs more than the stronger model does), or step 3 leaves genuine design judgment unresolved rather than a fuzzy term to look up.
- `haiku` — the unit is mechanical and fully specified, such as one batch of an expand-migrate-contract sequence applying a pattern the batch before it already fixed.
- Nothing, for everything else. Omitting the recommendation is what tells `/issue` to build the unit on the calling session's own model.

**When the work grows mid-session, say what it now costs.** Each addition gets judged against the one before it rather than the original ask, so a run of reasonable expansions quadruples a change without anyone deciding to. Name the new total and what it drags behind it — its own tests, another documentation sweep, another review round — so continuing is chosen rather than defaulted into.

### 5. Enumerate the failure modes when state cannot be put back

**Skip this step unless the work changes state it cannot put back** — a migration, a backfill, a script that rewrites or deletes rows, a secret rotation, a one-way call into somebody else's system. Most work is safe to get wrong once, because a wrong query just returns wrong rows until somebody fixes it. This kind is not: get it wrong and what it touched is gone. The test is whether running it twice, or running only half of it, could leave something nobody can put back.

**What this step produces:** one line answering each question below. They go in the issue under **Failure modes**, and later as a header comment on the thing itself, so it gets built to satisfy them rather than discovering them one at a time. They are asked now because they cost minutes while the change is still an idea, and a review round each once it is code.

- **If it stops halfway, what has already happened and what has not?** A migration file's statements run one at a time with nothing wrapping them, so a file that fails in the middle leaves everything before the failure applied and nothing after it.
- **What happens the second time it runs?** Work that did not finish is never recorded as finished, so the next deploy runs it again — and since a failed migration fails the deploy, the old code carries on writing in the meantime.
- **What happens to the rows that already break the new rule?** The rows written before the rule existed are the likeliest to break it. **Refuse loudly rather than dropping them**, and never inherit whatever the tool does by default: a row dropped to get a migration through is somebody's, and the deploy stopping costs one fix by hand.
- **What is actually in each environment?** Real data in both, from 7 September 2026 — see "The environments" in `docs/deployment.md` for what that forbids.
- **At which exact moments can it be interrupted, and what has to be true at each?** List them. "Before the swap" and "during the swap" are different questions with different right answers.

None of these was asked on "Make the database enforce the schema conventions, not just the callers" (pull request 69). It then took five rounds of review to find four separate ways that one change could have destroyed data — the first being a rebuild that would have emptied staging and production — and three of the four were introduced by the fix for the one before it. The question that set the whole sequence off was the fourth one above, and two greps would have answered it.

The answers are also rows for the statement list in step 6: *a re-run after an interruption loses nothing* is one rule with a case per interruption window.

### 6. Generate the statement list

Follow [.claude/skills/testing/references/statement-lists.md](../testing/references/statement-lists.md) exactly — the passes in order, the collapsing step, the pruning criterion, the ways-things-break checklist — using the docs read in step 1.

This tells the build agent which tests to implement, which is why it is drafted now, while the scope is still small enough to reason about. It stops being authoritative once building starts: the test names in source supersede it, per "Name it after the product" in the testing skill. If this is going into a GitHub issue, head that section verbatim:

> Drafted for build-time reference. Once implemented, these become test names in source per the testing skill; this list is not maintained afterward.

### 7. Gate before building or filing

Do not proceed — to code or to `gh issue create` — if any of these holds:

- The work puts up a surface nobody has seen and step 2's question was never asked → step 2.
- The slice is too big for one sitting → step 4.
- The work changes state it cannot put back and its failure modes are not written down → step 5. A review round is an expensive way to be told what a checklist asks.
- Any real behaviour this work describes has no row in the statement list → step 6.

## Output

A scoped unit of work (or several, in dependency order), its statement list, and — where it changes state it cannot put back — the failure modes its implementation must satisfy. Either hand off to the `github-issue` skill, which covers only the body template and publishing, or build it directly with the statement list going straight into the test files.
