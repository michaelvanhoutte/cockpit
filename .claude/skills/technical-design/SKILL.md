---
name: technical-design
description: Cockpit's process for settling the architecture of a piece of work before it is built - where data lives, which service owns what, sync or async, and what that does to scalability, performance, availability, supportability and maintainability. Run by the engineer, after the `scoping` skill (product scope) and before building or filing; never talks about code. Skip it where the work stays inside a shape architecture.md already settles.
---

# Designing it technically

`scoping` fixes **what** is built and is runnable by a product owner; this skill fixes **how it is shaped** and is run by an engineer. It stays at architecture level: stores, services, boundaries, communication style, quality attributes. Functions, types and file layout are the builder's.

## Process

### 1. Read the inputs

The scoped work (statement list, units, failure modes), [architecture.md](../../../docs/architecture.md) — especially its drivers, data layer, backend and performance budgets — the topic docs for the area (`*-options.md`, [deployment.md](../../../docs/deployment.md)), and open and closed issues and pull requests in the same area. Never ask what those answer.

### 2. Decide whether it needs a design

| Needs one | Does not |
|---|---|
| a new store, table family or change of what owns a row | a change inside one component, following a pattern architecture.md already records |
| a new service, queue, cron, Durable Object or external call | UI-only or copy changes |
| a new sync/async boundary, or a change of one | a bug fix that restores the intended shape |
| a change to a budget, an isolation boundary or a failure path | |

**Where it does not, say "no design needed" and why in a line, then stop.** Never design for its own sake.

### 3. Walk the decisions

One round at a time, numbered, each with a recommended answer and the alternative it beats, opened with the concrete scenario rather than the component name. Only decisions that apply:

| Decision | Settle |
|---|---|
| **Data placement** | which store owns each piece of data, who may write it, what is derived and how it is rebuilt |
| **Service placement** | which Worker, Durable Object or queue consumer owns the behaviour, and why not the neighbour |
| **Communication** | sync or async per call; what the caller sees while it is in flight and if it fails |
| **Consistency** | what may be stale, for how long, and who notices |
| **Failure and recovery** | what happens on timeout, retry, duplicate delivery and partial completion; what is idempotent |
| **Scale and cost** | the growth axis (items, accounts, connectors), the first thing to hit a limit, and the platform limit it hits |
| **Performance** | the budget in architecture.md "Performance budgets" it touches and the path it adds to |
| **Availability and security** | what the feature does when a dependency is down; what crosses a tenant or account boundary |
| **Supportability and maintainability** | how it is observed and debugged in production; what is expensive to change later |

**Challenge the result rather than presenting it**: name what was chosen and rejected for each, and what would make the choice wrong. An unanswered question that would change the diff is unfinished design, not an entry under open questions.

### 4. Record it where it lasts

- **For work being filed:** a `## Technical design` section in the issue, per [github-issue](../github-issue/SKILL.md): one line per decision, the reason in a clause, the rejected alternative named. No diagrams longer than a few lines.
- **For work built directly:** the same lines in the pull request body.
- **Once built**, a decision that is expensive to change is amended into architecture.md in place, per its closing section; one an options document researched stays in that document. Never a separate design document, and never `docs/adr/`.

### 5. Feed the unit sizing back

A design that adds a store, a service or a migration changes `scoping`'s units and models: re-check the split, the **Blocked by** order, any new failure modes under step 5 of `scoping`, and add statement-list rows for each failure path the design names. State the changes; do not redo scoping.

### 6. Gate before building or filing

Do not proceed if a decision in step 3 that applies has no recorded answer, if a design adds state that cannot be put back and `scoping`'s failure modes do not cover it, or if the design contradicts architecture.md without saying which of the two changes.

## Output

"No design needed" with its reason, or the decision lines for the issue or pull request, plus any changes to the units, models and statement list.
