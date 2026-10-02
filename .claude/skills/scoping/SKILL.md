---
name: scoping
description: Cockpit's process for deciding whether a piece of work has to be seen before it is scoped and for sharpening fuzzy requirements into the whole, unsliced piece of work - before any design, slicing or code. Run by product or an engineer; hands off to `technical-design` and `slicing`. Use whenever starting new feature work, a bug fix, or a larger request, whether or not it will become a GitHub issue. Triggers on the work starting, not on the decision to file an issue.
---

# Scoping a piece of work

Fuzzy scope is where features go wrong, before a line of code or an issue exists. This runs on **any** new piece of work, and starting the work is the trigger. It ends by filing the ticket the next two skills build on.

## Process

### 1. Read the inputs

- The request itself: the conversation, the `ideas.md` entry, the bug report.
- The existing rules for every part of the product this touches: the relevant file(s) in [docs/product/](../../../docs/product/), [functional-definition.md](../../../docs/functional-definition.md) for purpose, problems and open decisions, [architecture.md](../../../docs/architecture.md), and any topic doc for the area (e.g. [routing-learning.md](../../../docs/routing-learning.md), [testing-strategy.md](../../../docs/testing-strategy.md) for test placement).
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

**A question is unresolved scope, not open scope, whenever two answers to it would produce different diffs.** Close it here through discussion, or — where the doubt is about a surface nobody has seen — via step 2's POC; never carry it forward for whoever builds the issue to answer. "Take the width and the name off a layout, now that its size carries them" (issue 264) is a case discussion alone would have closed: its body named wiping every Layout's arrangement as "the agreed trade," described the alternative, said "Decide before building," and then listed that same question as out of scope anyway; a full review round went on the question that was already known to be open before a line was written.

Use the `grilling` skill's round-based interview (mattpocock-skills): number each open question, give a recommended answer, work one round at a time until nothing about the scope is fuzzy. Skip only when the request is already small and unambiguous.

**Open with the concrete scenario, not the column name or the doc citation.** A question framed first around implementation detail costs a round trip the same question would not have asked plainly: "Learn how you write from the titles you correct" (issue 394) opened with `items.unseen`, functional-definition.md's own undecided routing question, and an unbuilt-feature reference, came back "I don't understand your question," and only landed once restated as what the person would actually see - a title proposed a moment ago, still unread in the Inbox.

Do not write to `CONTEXT.md` or `docs/adr/` — Cockpit's product rules and glossary live in `docs/product/`, its open decisions in `functional-definition.md`, its architecture in `architecture.md`, and integration research in the `*-options.md` docs. Record anything permanent there, as the rule now stands and only once it is built: what the person sees, what the UI tells them and how it behaves. How it looks belongs in `docs/design-system.md`. Behaviour shared across features is stated once, in `docs/product/across-the-app.md`, and referred to from the feature. A rule is edited in place rather than appended, with its reason in a clause where it would otherwise look arbitrary. Designs not yet built go to `docs/ideas.md`, marked as decided where they are; what a rule replaced and which issue decided it stay in git and the issue.

### 4. Gate before designing or slicing

Do not hand off if any of these holds:

- The work puts up a surface nobody has seen and step 2's question was never asked → step 2.
- A question would produce a different diff depending on its answer → step 3, or step 2's POC where discussion can't settle it. It is unfinished scope, not an entry for **Out of scope / open questions**.

## Output

**File the whole piece of work as one ticket**, unsliced, through the [github-issue](../github-issue/SKILL.md) skill: Problem, What to build and Out of scope, labelled `unsliced`, which tells `/build` and any reader that design and slicing have not run. Product can stop here; an engineer picks the ticket up by number.

Name what runs next and who runs it; nothing here calls it:

- [technical-design](../technical-design/SKILL.md), by the engineer, where the work stores data, crosses a sync or async boundary, adds an integration or job, or changes state it cannot put back. It adds its sections to the ticket.
- [slicing](../slicing/SKILL.md), by the engineer, always, after design where design applied. It finishes the ticket or splits it into children under it.
