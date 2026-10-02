---
name: slicing
description: Cockpit's process for cutting a scoped and designed piece of work into vertical slices in dependency order, naming the model that builds each unit, and producing its statement list of test cases - before any code is written. Run by the engineer after `scoping` and, where it applied, `technical-design`; Starts from the ticket `scoping` filed and either finishes it or splits it into child tickets under it as parent. Use whenever a ticket labelled `unsliced` is about to be built.
---

# Slicing the work

`scoping` settled *what* is built, `technical-design` *how it fits the system*; this settles *in which pieces*. It runs last because the cut depends on both: a design that needs an expand-then-contract migration, a queue or a new integration decides where the seams fall, and a statement list drafted earlier misses the rows the design adds. It runs on the whole scope and the whole design at once, so no unit is cut against half of either.

## Process

### 1. Read the inputs

The ticket you are given: the Problem and What to build from `scoping`, the **Technical design** and **Failure modes** from `technical-design` (or its "No design needed"). [testing-strategy.md](../../../docs/testing-strategy.md) settles test placement. A bug fix has no design; read the report and the code it names.

### 2. Size it as a vertical slice

One unit of work is one narrow but complete path through every layer it touches (schema, API, UI, tests): demoable on its own, and sized to fit a single fresh context window.

**A context window is one measure of size, and elapsed time is the other.** `main` merges roughly one pull request an hour, and a branch pays for every one that lands while it is open — twelve landed under "Edit an item's title and description on a form of its own" (pull request 163) in fifteen hours, costing six merges that each re-resolved the Item model, capture and the row, and a full re-run of three test tiers apiece. Ask whether the slice can be *merged today*, not only whether it fits a sitting; where it cannot, split it again.

If the request doesn't fit, split it into units in dependency order, each declaring what it is **blocked by**. Work the frontier of unblocked units first; if they get filed, that is also the filing order.

**Exception:** a wide mechanical refactor (rename a shared symbol, retype a column) can't be sliced vertically. Sequence it as expand (add the new form beside the old) → migrate in batches, each its own unit blocked by the expand → contract (delete the old form), blocked by every batch.

**Name the model that builds each unit, every unit, with a one-line reason** — never "default" and never nothing, since the session that builds it is rarely the one that sliced it:

- `opus` — the unit changes state it cannot put back (so a wrong call costs more than the stronger model does), or `scoping` or `technical-design` left genuine design judgment unresolved rather than a fuzzy term to look up. A migrate batch that itself changes such state — a data backfill, a row rewrite — stays `opus` however mechanical its pattern looks.
- `haiku` — the unit is mechanical, fully specified, and changes no state it cannot put back: a shared-symbol rename swept across files, or a migrate batch that only touches code, never stored data.
- `sonnet` — everything else.

**When the work grows mid-session, say what it now costs.** Each addition gets judged against the one before it rather than the original ask, so a run of reasonable expansions quadruples a change without anyone deciding to. Name the new total and what it drags behind it — its own tests, another documentation sweep, another review round — so continuing is chosen rather than defaulted into.

### 3. Generate each unit's statement list

**Write a list per unit, after the cut, and never split a finished list across units**: a row divided out afterwards lands in the wrong ticket or in none. Follow [.claude/skills/testing/references/statement-lists.md](../testing/references/statement-lists.md) exactly — the passes in order, the collapsing step, the pruning criterion, the ways-things-break checklist — using the docs read in `scoping` step 1. The failure modes from `technical-design` are rows: *a re-run after an interruption loses nothing* is one rule with a case per interruption window.

This tells the build agent which tests to implement, which is why it is drafted now, while each unit is still small enough to reason about. It stops being authoritative once building starts: the test names in source supersede it, per "Name it after the product" in the testing skill. Head each unit's section verbatim:

> Drafted for build-time reference. Once implemented, these become test names in source per the testing skill; this list is not maintained afterward.

### 4. Check the coverage

Build a table with one row per rule in the ticket's What to build and per line of its Failure modes, naming **the one unit that owns it**. A rule that spans units goes to the one that completes the path, the last in dependency order. Then the other direction: every row in a unit's statement list traces to a rule or failure mode in the table. The table goes on the parent as **Coverage**.

### 5. Gate before filing

Do not file if any of these holds:

- `scoping`'s gate or `technical-design`'s gate was not passed for this work → return to that skill, never settle it here.
- The slice is too big for one sitting, or a unit names no model → step 2.
- A rule or failure mode has no owning unit, or a statement row traces to none → step 4.
- A cut would produce a different diff depending on a question nobody answered → that question belongs to `scoping` or `technical-design`; send it back rather than carrying it as an entry for **Out of scope / open questions**.

### 6. Finish the ticket

Through [github-issue](../github-issue/SKILL.md), which holds the template and commands:

- **One unit:** add Blocked by, Model and Test cases to the same ticket and remove `unsliced`.
- **Several units:** create each child with its own slice of the design, failure modes, Blocked by, Model and Test cases, blockers first; then turn the original into the parent with **Children** and **Coverage**, and remove `unsliced` from it.

## Output

The ticket finished, or a parent with its children. Build each by number with `/build`.
