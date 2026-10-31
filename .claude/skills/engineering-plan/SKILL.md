---
name: engineering-plan
description: Cockpit's process for turning a scoped ticket into something buildable - first settling the architecture through seven lenses (growth and waiting, stored shape, boundaries and placement, state and consistency, failure and recovery, running it, trust), each answered in one line and drawn where it moves, as a diff to the architecture page's databases and modules, with every change to a database's tables, columns and indexes stated in full, then, once the engineer has agreed the design, cutting the work into vertical slices with a model and a statement list of test cases per unit. Run by the engineer after `scoping`, in two phases with a stop between them; finishes the ticket or splits it into child tickets under it as parent. Use whenever a ticket labelled `unsliced` is about to be built. Never a code-level discussion.
---

# Planning the engineering

`scoping` settles *what* is built and for whom; this settles *how it fits the system* and then *in which pieces*. Product can run scoping alone; this is the engineer's, because its questions are about cost, load and failure. It starts from the ticket `scoping` filed and adds to that ticket.

## Where to start

Read the ticket, then start from what it already carries. Nothing here calls another skill.

| The ticket has | Start at |
|---|---|
| a bug report | Slicing, step 8: a bug fix has no design, except one about speed, which starts at step 2 |
| no **Technical design** or "No design needed", and not a bug report | Design, step 1 |
| a design, still labelled `unsliced` | Slicing, step 8 |

The two phases are one skill so that one engineer pays for one invocation, and the stop between them is what keeps a long design discussion from sliding into slicing before it is agreed.

## Design

Design stops at what an engineer would draw on a whiteboard to explain the change to a colleague: the parts, their lifecycles and states, what talks to what, who owns which data and in what shape, and the guarantees between them. This repository's own classes, functions, files and module names are the builder's. It takes the ticket whole, before any slicing, so each decision sees all of it.

### The altitude

**A decision belongs here when it fits on that whiteboard and an engineer who never opens the code can challenge it**: a store, a boundary, a service, a request path (the round trips an action waits on, and what each sends and reads back, bounded by what), a stored shape (the table, the columns the product filters or sorts on, and the index each uses), a lifecycle (what state a part is in and what moves it on), who owns a piece of data, where a piece of logic lives and which entry points reach it, or a guarantee (what is consistent, how fresh, what survives an outage). **Name frameworks, platform APIs and protocols freely** (the service worker lifecycle, a Workbox strategy, SSE, D1, a queue): they are the shared vocabulary. Two levels fail:

- **Too low** names this repository's own classes, functions, files, endpoint shapes or the order of build steps. Leave it to the builder, even when asked a code-adjacent question. **A database's tables, columns and indexes are the exception**: step 3 states every change to them in full, because the structure outlives the issue, is the hardest part to put back, and is what the engineer would have designed differently where the builder optimises it for the task in hand.
- **Too high** asks what the person sees, how long they accept waiting, or what a message says. Those are `scoping`'s: take the ticket's answer as a constraint, and where it leaves one open, name it and send it back rather than asking it here. How many round trips that wait is spent on is decided here.

| Here | Not here |
|---|---|
| "Removing an Item from a Panel draws at once, waits on no round trip, and causes one Workspace read after it" | which hook draws it |
| "Opening a Workspace reads the Items now on it, never the ones that were ever on it" | the query |
| "Sync invoices to the ledger through a queue, not inline" | which handler enqueues it |
| "The activity feed lives in D1, with a status column the panel filter reads through an index" | the query that reads it |
| "Teams messages arrive by webhook, with a cron sweep for gaps" | the parsing code |
| "The core knows the connector framework and the registry, never a provider" | the file that imports it |
| "Capture is one command, reached by the form, MCP, SMS and every pushed source" | the route that calls it |
| "A stale feed is acceptable for a minute; a lost message is not" | the retry loop |
| "A new service worker installs and waits; open pages keep the old one until told to activate" | the module that sends the message |

**State each decision's consequences in system terms**: the states each part can be in, the interleavings that break it (several tabs, a deploy mid-session, an interrupted switch), what it costs in load or against a budget, and what stays unguarded. A name from this repository, as opposed to a framework or the platform, in a question or a decision means it has dropped to code.

Code is read in step 1 only to learn what already exists, and is never quoted in the output.

### 1. Read the inputs

The ticket (its number is what you are given), [architecture.md](../../../docs/architecture.md) — especially "Architectural drivers", "Data layer", "Backend architecture" and "Performance budgets" — [deployment.md](../../../docs/deployment.md), and the two models every design here is a diff to, both on the architecture page (<https://michaelvanhoutte.github.io/cockpit/architecture/>, drawn nightly by `tools/architecture`): **Databases**, every table, column and index of the register and of an account store with what is no longer used struck through, drawn from `apps/api/database-schema.json`; and **Modules** with **Dependencies**, every area of the web app, the API and the packages in its layer, what imports what and in how many files, drawn from `tools/architecture/description.yml` and the imports on disk. Read those two files where the page is older than `main`. Look at the code only to learn which stores, queues and connectors already exist, and the path each action the ticket touches takes today, before proposing anything new.

### 2. Trace the request path, then decide whether a design is needed

**Give each user action the ticket adds or changes that reaches the server one row, counted from the code**: the round trips the screen waits on before it shows the result, and the reads a change causes after it. Reusing an existing mechanism fires none of the other triggers below, so this row is what catches a slow path built on. Each row ends in one verdict:

| Verdict | When | Then |
|---|---|---|
| **Within the rule** | a change shows without waiting on a round trip and causes at most one read after it, in the background; a read waits on one, and every read is bounded by what is on screen | nothing more |
| **On a known path** | it breaks the rule on a path an open issue is already fixing | name that issue, nothing more |
| **A trigger** | it breaks the rule on a path nothing is fixing | measure it, then open the round below |

**Draw each row as two Mermaid sequence diagrams: before, the path today's code takes, and after, the path proposed.** For a new action, before is the nearest existing path it builds on. A row's numbers are easy to agree with and hard to challenge, and the diagram shows where they come from, so an engineer who never opens the code can point at the arrow that is wrong.

- **Use only the lanes the action touches, named for what they do**: UI, Local cache (what the device saves), Change announcements (the stream that tells open tabs something changed), API, Account store (the account's own database), Shared register (D1: accounts, sessions, and the directory an incoming message is attributed through), Queue, Files, and an outside sender or source by its own name.
- **Label every arrow with what it carries, how much, and what bounds it**: "the Items now on the Workspace, every status", "the last 50", "this week", "1 row", "3 queries". An arrow that says only "read" hides what a slow path is made of, and an arrow bounded by nothing is one that grows with the account's history.
- **End each diagram with one note giving the count**: the round trips the screen waits on, and the reads the change causes after it. That count is the row's, so a count over the rule makes the row a trigger.
- **Draw the path, and a branch only where it changes the count**, such as an announcement landing while a read is still in flight, since a diagram carrying every condition is too dense to challenge.
- **Name parts and the platform, never this repository's code**, as everywhere in the design.

**Measure only a trigger row, and never by changing deployed data**: time reads and their size on the deployed app, and time a change locally or while the person makes it, since "Deployed data is real" in CLAUDE.md forbids sending one there to time it.

**Take "no design needed" as the default** where every row is within the rule or on a known path, and say so in one line: a change that stays inside existing stores, commands, connectors and budgets decides nothing architectural. Open a design round only when a trigger fires:

- a new table class, store, or place data lives
- a read whose size grows with the account's history rather than with what is on screen
- a new sync/async boundary: a call that waits on another system, a queue, a cron, an SSE push
- a new external integration, or a new use of an existing one at a different volume
- a new background job
- a new trust boundary or secret
- a performance budget at risk, or a cost that grows with accounts, items or time
- a request-path row whose verdict is a trigger
- state it cannot put back (step 6)

Name which trigger fired. If none can be named, record "No design needed" with the rows, their diagrams and step 3's lens lines, the Schema changes among them, and go to step 7.

### 3. Answer the seven lenses, one line each

**Every run answers each lens in one line, trigger or not**, since the lens that was never applied is how a stored shape or a boundary gets decided by the builder alone. The line is the decision, or "nothing moves here, because …" with the reason: a claim the periodic review can later show was wrong, never a box ticked. A lens that moves gets its drawing, in the format the table gives, and a round in step 4.

| Lens | The question | What catches it |
|---|---|---|
| Growth and waiting | What grows with accounts, items or time, what bounds each read, and how many round trips does each action wait on? | step 2's rows and diagrams |
| Stored shape | What is stored, which queries read it, which index each filter or sort uses, and which store owns it? | an entity diagram of the touched tables and one hop around them, added or changed columns marked "(new)", and the Schema changes table below; an index cell left empty for a filtered column is the finding |
| Boundaries and placement | Which part learns about which other part, where does this logic live, which entry points reach it, and what is sync or queued? | a component diagram of the touched parts, grouped by app or package, dependency arrows with new ones marked "new", and one row per capability naming the command and the entry points that reach it |
| State and consistency | Which states can each part be in, what moves it on, which interleavings break it, and how stale is acceptable? | a state diagram, then a table of scenario (two tabs, a deploy mid-session, a reconnect), what each party sees, and how stale that is allowed to be |
| Failure and recovery | What still works when a part is down, what does the person see, and what cannot be put back if it stops halfway or runs twice? | a table of part down, what still works, what the person sees; and step 6's lines where state cannot be put back |
| Running it | What does it cost per account or per day, which platform limit does it approach, and how does someone find out it broke? | a table of cost driver, per account or per day, the limit it approaches, headroom, and how it is noticed |
| Trust | Does it add a trust boundary, a secret or a new caller, and who may call it? | one line, or a table of new caller, what it may do, how it is authenticated; a sequence diagram only for a new sign-in flow |

**State every change the work makes to a database's structure, one row per change, under the ticket's Schema changes**, for each database it touches: an account's store, the shared register, the Harness Monitor's. A reviewer and the next builder read the structure from here rather than from a migration buried in the diff.

| Database | Table | Change | Serves | Measured |
|---|---|---|---|---|
| which one | which table | a table, column or index added, changed, dropped, or a column left in place but no longer used | the reads or writes that use it, each filter or sort naming the index it uses | for an index, the query plan and rows read before and after |

**A column the work stops using is a row, marked unused**, and stays in the table until a contract step drops it, so nobody reads it later as live. Where the work changes no structure, the lens line reads "No schema change", having checked the migrations rather than assumed it.

**Draw the delta, not the world.** Each diagram shows the slice the change touches and one hop around it; the whole is on the architecture page, and a drawing that repeats it is one nobody reads. **Mark change in the label, not the colour**, since GitHub drops some Mermaid styling and a text reader sees none. **Every diagram is Mermaid**, because the design lives in the issue and nothing else renders there. **The lens prefixes each question in step 4** ("Stored shape: a Teams message arrives while the app is closed …"), so the engineer knows which judgment to bring without losing the scenario it is judged on.

### 4. Walk the decisions the change forces

Work one round at a time with the `grilling` skill's interview: number each question, prefix it with its lens, give a recommended answer, open with the concrete scenario ("a Teams message arrives while the app is closed") rather than the component name. Only the lenses step 3 found moving.

Settle the placement questions explicitly: which store owns each piece of data, what is synchronous and what is queued, which Worker or service runs it, which existing mechanism it reuses, and which one command the capability is, reached by every entry point that offers it. **Prefer the existing mechanism**, unless step 2 made its row a trigger; a new store, queue or service has to name what the existing one cannot do. Where the change stores nothing, settle the lifecycle instead: which part is in which state, and what moves it on.

**Offer each option as an arrangement of parts and what it does under the scenario**: the states it passes through, what it costs, what it leaves unguarded.

**Challenge the result rather than presenting it**: name what you chose and what you rejected, and ask the engineer about each. A question whose two answers would produce different diffs is closed here, not carried into the issue.

### 5. Record the decisions

One entry per decision, four lines at most: the decision as an arrangement of parts, the option rejected and why in a clause, what it costs or limits in the system, and the risk it leaves open. A remaining risk goes in its entry, not in a closing note. These become the ticket's **Technical design** section, opened by step 2's rows and their diagrams, then step 3's seven lens lines with the drawings of the lenses that move, each trigger row as decided beside what was measured, with the **Schema changes** as their own section, and added through [github-issue](../github-issue/SKILL.md) with the rest of the body untouched.

**A decision that outlives the issue goes to `architecture.md`, edited in place and only once built**, as the rule now stands with its reason in a clause; **a drawing that changed a model reaches the model in the pull request that builds it**: a new area or a moved layer is described in `tools/architecture/description.yml`, and the schema file is rewritten by its test (`tools/architecture/README.md`, "Databases"), so the architecture page stays what the next design is a diff to. Nothing goes to `docs/adr/`; what was weighed stays in the issue.

**Do not slice in this phase.** Where a decision forces a seam (an expand-then-contract migration, a queue between two parts), say so in its entry.

### 6. Enumerate the failure modes when state cannot be put back

**Skip this step unless the work changes state it cannot put back** — a migration, a backfill, a script that rewrites or deletes rows, a secret rotation, a one-way call into somebody else's system. The test is whether running it twice, or running only half of it, could leave something nobody can put back. Such a unit's recommended model is `opus`.

**This step produces one line answering each question below.** They go in the ticket under **Failure modes**, and later as a header comment on the thing itself, so it is built to satisfy them rather than discovering them one at a time.

- **If it stops halfway, what has already happened and what has not?** Say it as the state of the data, not the steps of the code: a failure in the middle leaves the earlier part applied and the later part not.
- **What happens the second time it runs?** Work that did not finish is never recorded as finished, so the next deploy runs it again — and since a failed migration fails the deploy, the old code carries on writing in the meantime.
- **What happens to the rows that already break the new rule?** The rows written before the rule existed are the likeliest to break it. **Refuse loudly rather than dropping them**, and never inherit whatever the tool does by default.
- **What is actually in each environment?** Real data in both staging and production — see "The environments" in `docs/deployment.md` for what that forbids.
- **At which exact moments can it be interrupted, and what has to be true at each?** List them. "Before the swap" and "during the swap" are different questions with different right answers.

"Make the database enforce the schema conventions, not just the callers" (pull request 69) took five rounds of review to find four ways one change could destroy data, the first being a rebuild that would have emptied staging and production. The fourth question, answered by two greps, would have found it.

The answers become rows in the statement lists step 9 writes: *a re-run after an interruption loses nothing* is one rule with a case per interruption window.

### 7. Gate: is the design agreed?

Add the decisions and failure modes to the ticket, then **stop and ask the engineer whether the design is agreed. Start step 8 only on a yes.** A long discussion is the normal case here, so the ticket carrying the design is what lets slicing start in a fresh session.

Do not ask, and do not slice, if:

- An action the ticket adds or changes has no row or no before and after diagram in step 2, or a trigger row was never measured.
- A read arrow names no bound.
- A lens has no line, or a lens that moves has no drawing.
- The ticket has no Schema changes, a filtered or sorted column in it names no index and no reason, or an index in it has no measured query plan.
- A new dependency between parts is not in the component diagram, or points up the order `scripts/import-rules.json` declares, which CI fails on.
- A capability reachable from more than one entry point names no single command.
- A trigger fired in step 2 and its decisions are not recorded.
- A placement question (store, sync or async, service) is still open.
- The work changes state it cannot put back and its failure modes are not written down.
- A new store, queue or service is proposed without naming what the existing mechanism cannot do.

## Slicing

It runs after design because the cut depends on it: a design that needs an expand-then-contract migration, a queue or a new integration decides where the seams fall, and a statement list drafted earlier misses the rows the design adds. It runs on the whole scope and the whole design at once, so no unit is cut against half of either.

### 8. Size it as a vertical slice

One unit of work is one narrow but complete path through every layer it touches (schema, API, UI, tests): demoable on its own, and sized to fit a single fresh context window.

**A context window is one measure of size, and elapsed time is the other.** `main` merges roughly one pull request an hour, and a branch pays for every one that lands while it is open — twelve landed under "Edit an item's title and description on a form of its own" (pull request 163) in fifteen hours, costing six merges that each re-resolved the Item model, capture and the row, and a full re-run of three test tiers apiece. Ask whether the slice can be *merged today*, not only whether it fits a sitting; where it cannot, split it again.

If the request doesn't fit, split it into units in dependency order, each declaring what it is **blocked by**. Work the frontier of unblocked units first; if they get filed, that is also the filing order.

**Exception:** a wide mechanical refactor (rename a shared symbol, retype a column) can't be sliced vertically. Sequence it as expand (add the new form beside the old) → migrate in batches, each its own unit blocked by the expand → contract (delete the old form), blocked by every batch.

**Name the model that builds each unit, every unit, with a one-line reason** — never "default" and never nothing, since the session that builds it is rarely the one that sliced it:

- `opus` — the unit changes state it cannot put back (so a wrong call costs more than the stronger model does), or `scoping` or the design left genuine design judgment unresolved rather than a fuzzy term to look up. A migrate batch that itself changes such state — a data backfill, a row rewrite — stays `opus` however mechanical its pattern looks.
- `haiku` — the unit is mechanical, fully specified, and changes no state it cannot put back: a shared-symbol rename swept across files, or a migrate batch that only touches code, never stored data.
- `sonnet` — everything else.

**When the work grows mid-session, say what it now costs.** Each addition gets judged against the one before it rather than the original ask, so a run of reasonable expansions quadruples a change without anyone deciding to. Name the new total and what it drags behind it — its own tests, another documentation sweep, another review round — so continuing is chosen rather than defaulted into.

### 9. Generate each unit's statement list

**Write a list per unit, after the cut, and never split a finished list across units**: a row divided out afterwards lands in the wrong ticket or in none. Follow [.claude/skills/testing/references/statement-lists.md](../testing/references/statement-lists.md) exactly — the passes in order, the collapsing step, the pruning criterion, the ways-things-break checklist — using the docs `scoping` read and [testing-strategy.md](../../../docs/testing-strategy.md) for test placement. The failure modes from step 6 are rows, and so is each lens line that claims a bound or a shape: *opening a Workspace with a thousand finished Items reads the same as with none*, *the status filter's query plan uses an index*, *creating an Item over MCP runs the same command as the form*, each provable at the integration tier.

This tells the build agent which tests to implement, which is why it is drafted now, while each unit is still small enough to reason about. It stops being authoritative once building starts: the test names in source supersede it, per "Name it after the product" in the testing skill. Head each unit's section verbatim:

> Drafted for build-time reference. Once implemented, these become test names in source per the testing skill; this list is not maintained afterward.

### 10. Check the coverage

Build a table with one row per rule in the ticket's What to build and per line of its Failure modes, naming **the one unit that owns it**. A rule that spans units goes to the one that completes the path, the last in dependency order. Then the other direction: every row in a unit's statement list traces to a rule or failure mode in the table. The table goes on the parent as **Coverage**.

### 11. Gate before filing

Do not file if any of these holds:

- Step 7's gate was not passed, or `scoping`'s was not → return to that step or skill, never settle it here.
- The slice is too big for one sitting, or a unit names no model → step 8.
- A rule or failure mode has no owning unit, or a statement row traces to none → step 10.
- A cut would produce a different diff depending on a question nobody answered → it belongs to `scoping` or design; send it back rather than carrying it as an entry for **Out of scope / open questions**.

### 12. Finish the ticket

Through [github-issue](../github-issue/SKILL.md), which holds the template and commands:

- **One unit:** add Blocked by, Model and Test cases to the same ticket and remove `unsliced`.
- **Several units:** create each child with its own slice of the design, failure modes, Blocked by, Model and Test cases, blockers first, each titled by github-issue's [Title](../github-issue/SKILL.md#title) rule, which has a child name its parent's feature; then turn the original into the parent with **Children** and **Coverage**, and remove `unsliced` from it.

## Output

"No design needed" with step 2's rows and their diagrams, the trigger check in one line and step 3's seven lens lines, or a **Technical design** section carrying the rows, the lens lines, the drawings of the lenses that move and the decisions, and the **Failure modes** where step 6 applied, with the **Schema changes** either way; then, once the design is agreed, the ticket finished, or a parent with its children. Build each by number with `/build`.
