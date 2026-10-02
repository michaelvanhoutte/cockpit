---
name: engineering-plan
description: Cockpit's process for turning a scoped ticket into something buildable - first settling the architecture (which store owns the data, sync or async, which service or Worker, what it costs to run and support, the failure modes of anything that changes state it cannot put back), then, once the engineer has agreed the design, cutting the work into vertical slices with a model and a statement list of test cases per unit. Run by the engineer after `scoping`, in two phases with a stop between them; finishes the ticket or splits it into child tickets under it as parent. Use whenever a ticket labelled `unsliced` is about to be built. Never a code-level discussion.
---

# Planning the engineering

`scoping` settles *what* is built and for whom; this settles *how it fits the system* and then *in which pieces*. Product can run scoping alone; this is the engineer's, because its questions are about cost, load and failure. It starts from the ticket `scoping` filed and adds to that ticket.

## Where to start

Read the ticket, then start from what it already carries. Nothing here calls another skill.

| The ticket has | Start at |
|---|---|
| a bug report | Slicing, step 7: a bug fix has no design |
| no **Technical design** or "No design needed", and not a bug report | Design, step 1 |
| a design, still labelled `unsliced` | Slicing, step 7 |

The two phases are one skill so that one engineer pays for one invocation, and the stop between them is what keeps a long design discussion from sliding into slicing before it is agreed.

## Design

Design stops at services, stores, boundaries and ownership. Classes, functions and file layout are the builder's. It takes the ticket whole, before any slicing, so each decision sees all of it.

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

**Take "no design needed" as the default** and say so in one line: a change that stays inside existing stores, commands, connectors and budgets decides nothing architectural. Open a design round only when a trigger fires:

- a new table class, store, or place data lives
- a new sync/async boundary: a call that waits on another system, a queue, a cron, an SSE push
- a new external integration, or a new use of an existing one at a different volume
- a new background job
- a new trust boundary or secret
- a performance budget at risk, or a cost that grows with accounts, items or time
- state it cannot put back (step 5)

Name which trigger fired. If none can be named, record "No design needed" and go to step 6.

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

**Do not slice in this phase.** Where a decision forces a seam (an expand-then-contract migration, a queue between two parts), say so in its entry.

### 5. Enumerate the failure modes when state cannot be put back

**Skip this step unless the work changes state it cannot put back** — a migration, a backfill, a script that rewrites or deletes rows, a secret rotation, a one-way call into somebody else's system. The test is whether running it twice, or running only half of it, could leave something nobody can put back. Such a unit's recommended model is `opus`.

**This step produces one line answering each question below.** They go in the ticket under **Failure modes**, and later as a header comment on the thing itself, so it is built to satisfy them rather than discovering them one at a time.

- **If it stops halfway, what has already happened and what has not?** Say it as the state of the data, not the steps of the code: a failure in the middle leaves the earlier part applied and the later part not.
- **What happens the second time it runs?** Work that did not finish is never recorded as finished, so the next deploy runs it again — and since a failed migration fails the deploy, the old code carries on writing in the meantime.
- **What happens to the rows that already break the new rule?** The rows written before the rule existed are the likeliest to break it. **Refuse loudly rather than dropping them**, and never inherit whatever the tool does by default.
- **What is actually in each environment?** Real data in both staging and production — see "The environments" in `docs/deployment.md` for what that forbids.
- **At which exact moments can it be interrupted, and what has to be true at each?** List them. "Before the swap" and "during the swap" are different questions with different right answers.

"Make the database enforce the schema conventions, not just the callers" (pull request 69) took five rounds of review to find four ways one change could destroy data, the first being a rebuild that would have emptied staging and production. The fourth question, answered by two greps, would have found it.

The answers become rows in the statement lists step 8 writes: *a re-run after an interruption loses nothing* is one rule with a case per interruption window.

### 6. Gate: is the design agreed?

Add the decisions and failure modes to the ticket, then **stop and ask the engineer whether the design is agreed. Start step 7 only on a yes.** A long discussion is the normal case here, so the ticket carrying the design is what lets slicing start in a fresh session.

Do not ask, and do not slice, if:

- A trigger fired in step 2 and its decisions are not recorded.
- A placement question (store, sync or async, service) is still open.
- The work changes state it cannot put back and its failure modes are not written down.
- A new store, queue or service is proposed without naming what the existing mechanism cannot do.

## Slicing

It runs after design because the cut depends on it: a design that needs an expand-then-contract migration, a queue or a new integration decides where the seams fall, and a statement list drafted earlier misses the rows the design adds. It runs on the whole scope and the whole design at once, so no unit is cut against half of either.

### 7. Size it as a vertical slice

One unit of work is one narrow but complete path through every layer it touches (schema, API, UI, tests): demoable on its own, and sized to fit a single fresh context window.

**A context window is one measure of size, and elapsed time is the other.** `main` merges roughly one pull request an hour, and a branch pays for every one that lands while it is open — twelve landed under "Edit an item's title and description on a form of its own" (pull request 163) in fifteen hours, costing six merges that each re-resolved the Item model, capture and the row, and a full re-run of three test tiers apiece. Ask whether the slice can be *merged today*, not only whether it fits a sitting; where it cannot, split it again.

If the request doesn't fit, split it into units in dependency order, each declaring what it is **blocked by**. Work the frontier of unblocked units first; if they get filed, that is also the filing order.

**Exception:** a wide mechanical refactor (rename a shared symbol, retype a column) can't be sliced vertically. Sequence it as expand (add the new form beside the old) → migrate in batches, each its own unit blocked by the expand → contract (delete the old form), blocked by every batch.

**Name the model that builds each unit, every unit, with a one-line reason** — never "default" and never nothing, since the session that builds it is rarely the one that sliced it:

- `opus` — the unit changes state it cannot put back (so a wrong call costs more than the stronger model does), or `scoping` or the design left genuine design judgment unresolved rather than a fuzzy term to look up. A migrate batch that itself changes such state — a data backfill, a row rewrite — stays `opus` however mechanical its pattern looks.
- `haiku` — the unit is mechanical, fully specified, and changes no state it cannot put back: a shared-symbol rename swept across files, or a migrate batch that only touches code, never stored data.
- `sonnet` — everything else.

**When the work grows mid-session, say what it now costs.** Each addition gets judged against the one before it rather than the original ask, so a run of reasonable expansions quadruples a change without anyone deciding to. Name the new total and what it drags behind it — its own tests, another documentation sweep, another review round — so continuing is chosen rather than defaulted into.

### 8. Generate each unit's statement list

**Write a list per unit, after the cut, and never split a finished list across units**: a row divided out afterwards lands in the wrong ticket or in none. Follow [.claude/skills/testing/references/statement-lists.md](../testing/references/statement-lists.md) exactly — the passes in order, the collapsing step, the pruning criterion, the ways-things-break checklist — using the docs `scoping` read and [testing-strategy.md](../../../docs/testing-strategy.md) for test placement. The failure modes from step 5 are rows.

This tells the build agent which tests to implement, which is why it is drafted now, while each unit is still small enough to reason about. It stops being authoritative once building starts: the test names in source supersede it, per "Name it after the product" in the testing skill. Head each unit's section verbatim:

> Drafted for build-time reference. Once implemented, these become test names in source per the testing skill; this list is not maintained afterward.

### 9. Check the coverage

Build a table with one row per rule in the ticket's What to build and per line of its Failure modes, naming **the one unit that owns it**. A rule that spans units goes to the one that completes the path, the last in dependency order. Then the other direction: every row in a unit's statement list traces to a rule or failure mode in the table. The table goes on the parent as **Coverage**.

### 10. Gate before filing

Do not file if any of these holds:

- Step 6's gate was not passed, or `scoping`'s was not → return to that step or skill, never settle it here.
- The slice is too big for one sitting, or a unit names no model → step 7.
- A rule or failure mode has no owning unit, or a statement row traces to none → step 9.
- A cut would produce a different diff depending on a question nobody answered → it belongs to `scoping` or design; send it back rather than carrying it as an entry for **Out of scope / open questions**.

### 11. Finish the ticket

Through [github-issue](../github-issue/SKILL.md), which holds the template and commands:

- **One unit:** add Blocked by, Model and Test cases to the same ticket and remove `unsliced`.
- **Several units:** create each child with its own slice of the design, failure modes, Blocked by, Model and Test cases, blockers first; then turn the original into the parent with **Children** and **Coverage**, and remove `unsliced` from it.

## Output

"No design needed" with the trigger check in one line, or a **Technical design** section and the **Failure modes** where step 5 applied; then, once the design is agreed, the ticket finished, or a parent with its children. Build each by number with `/build`.
