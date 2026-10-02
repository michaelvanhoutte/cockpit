---
name: technical-design
description: Cockpit's process for settling the architecture of a scoped piece of work - which store owns the data, sync or async, which service or Worker it runs in, what it costs to run and support - and for enumerating the failure modes of anything that changes state it cannot put back, before any code is written. Run by the engineer after the `scoping` skill and before `slicing`; says "no design needed" when no trigger fires. Never a code-level discussion.
---

# Designing the technical shape

`scoping` settles *what* is built and for whom; this settles *how it fits the system*. Product can run scoping alone; this one is the engineer's, because its questions are about cost, load and failure. It starts from the ticket `scoping` filed, takes it whole before it is sliced so each decision sees all of it, adds its sections to that ticket, and stops at services, stores, boundaries and ownership. Classes, functions and file layout are the builder's.

## Process

### The altitude

**A decision belongs here only if it names a store, a boundary, a service, who owns a piece of data, or a guarantee** (what is consistent, how fresh, what survives an outage). Test each one: would an engineer who never opens the code still understand it and be able to challenge it? If it names a class, function, file, column, endpoint shape or the order of build steps, it is an implementation plan — leave it to the builder and do not raise it, even when asked a code-adjacent question.

| Here | Not here |
|---|---|
| "Sync invoices to the ledger through a queue, not inline" | which handler enqueues it |
| "The activity feed lives in D1, not a new store" | the columns and indexes |
| "Teams messages arrive by webhook, with a cron sweep for gaps" | the parsing code |
| "A stale feed is acceptable for a minute; a lost message is not" | the retry loop |

Code is read in step 1 only to learn what already exists, and is never quoted in the output.

### 1. Read the inputs

The ticket (its number is what you are given), [architecture.md](../../../docs/architecture.md) — especially "Architectural drivers", "Data layer", "Backend architecture" and "Performance budgets" — and [deployment.md](../../../docs/deployment.md). Look at the code only to learn which stores, queues and connectors already exist before proposing a new one.

### 2. Decide whether a design is needed

**Bug fixes skip this skill. Take "no design needed" as the default** and say so in one line: a change that stays inside existing stores, commands, connectors and budgets decides nothing architectural. Open a design round only when a trigger fires:

- a new table class, store, or place data lives
- a new sync/async boundary: a call that waits on another system, a queue, a cron, an SSE push
- a new external integration, or a new use of an existing one at a different volume
- a new background job
- a new trust boundary or secret
- a performance budget at risk, or a cost that grows with accounts, items or time
- state it cannot put back (step 5)

Name which trigger fired. If none can be named, stop here.

### 3. Walk the decisions the change forces

Work one round at a time with the `grilling` skill's interview: number each question, give a recommended answer, open with the concrete scenario ("a Teams message arrives while the app is closed") rather than the component name. Only the attributes the change actually moves, from this list:

| Attribute | The question |
|---|---|
| Scalability | What grows with accounts, items or time, and where does it stop being fine? |
| Performance | Which budget does it touch, and on the hot path or off it? |
| Availability | What still works when this part is down, and what does the person see? |
| Supportability | How does someone find out it broke, and what do they do about it? |
| Maintainability | Whose change does this make harder, and what would undo it? |

Settle the placement questions explicitly: which store owns each piece of data, what is synchronous and what is queued, which Worker or service runs it, and which existing mechanism it reuses. **Prefer the existing mechanism**; a new store, queue or service has to name what the existing one cannot do.

**Challenge the result rather than presenting it**: name what you chose and what you rejected, and ask the engineer about each. A question whose two answers would produce different diffs is closed here, not carried into the issue.

### 4. Record the decisions

One entry per decision, three lines at most: the decision, the option rejected and why in a clause, and what it costs later. These become the ticket's **Technical design** section, added through [github-issue](../github-issue/SKILL.md) with the rest of the body untouched.

**A decision that outlives the issue goes to `architecture.md`, edited in place and only once built**, as the rule now stands with its reason in a clause. Nothing goes to `docs/adr/`; what was weighed stays in the issue.

**Do not slice here.** The decisions go to the ticket whole, for [slicing](../slicing/SKILL.md); where one forces a seam (an expand-then-contract migration, a queue between two parts), say so in its entry.

### 5. Enumerate the failure modes when state cannot be put back

**Skip this step unless the work changes state it cannot put back** — a migration, a backfill, a script that rewrites or deletes rows, a secret rotation, a one-way call into somebody else's system. The test is whether running it twice, or running only half of it, could leave something nobody can put back. Such a unit's recommended model is `opus`.

**This step produces one line answering each question below.** They go in the ticket under **Failure modes**, and later as a header comment on the thing itself, so it is built to satisfy them rather than discovering them one at a time.

- **If it stops halfway, what has already happened and what has not?** Say it as the state of the data, not the steps of the code: a failure in the middle leaves the earlier part applied and the later part not.
- **What happens the second time it runs?** Work that did not finish is never recorded as finished, so the next deploy runs it again — and since a failed migration fails the deploy, the old code carries on writing in the meantime.
- **What happens to the rows that already break the new rule?** The rows written before the rule existed are the likeliest to break it. **Refuse loudly rather than dropping them**, and never inherit whatever the tool does by default.
- **What is actually in each environment?** Real data in both staging and production — see "The environments" in `docs/deployment.md` for what that forbids.
- **At which exact moments can it be interrupted, and what has to be true at each?** List them. "Before the swap" and "during the swap" are different questions with different right answers.

"Make the database enforce the schema conventions, not just the callers" (pull request 69) took five rounds of review to find four ways one change could destroy data, the first being a rebuild that would have emptied staging and production. The fourth question, answered by two greps, would have found it.

The answers become rows in the statement list `slicing` writes: *a re-run after an interruption loses nothing* is one rule with a case per interruption window.

### 6. Gate before building or filing

Do not hand off to `slicing`, or build, if:

- A trigger fired in step 2 and its decisions are not recorded.
- A placement question (store, sync or async, service) is still open.
- The work changes state it cannot put back and its failure modes are not written down.
- A new store, queue or service is proposed without naming what the existing mechanism cannot do.

## Output

"No design needed" with the trigger check in one line, or a **Technical design** section of decisions and the **Failure modes** where step 5 applied. Both are added to the ticket, which stays `unsliced`. Hand off to the `slicing` skill, run by the engineer.


