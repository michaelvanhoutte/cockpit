# Test Explorer: Build Spec

**Status:** built at `tools/test-explorer`, validated against the real,
merged test suite (commit `0897f91`, [PR #51](https://github.com/michaelvanhoutte/cockpit/pull/51)).
Settles the remaining open questions from
[testing-decisions-wip.md](testing-decisions-wip.md) that blocked
implementation, and is the authoritative shape from here on where it
disagrees with [coverage-reporting-options.md](coverage-reporting-options.md)
or the prototype in [poc/coverage-explorer](../poc/coverage-explorer/README.md).
Those two stay as the record of *why* — the options considered, the ones
rejected — this document is *what got built*, including one live correction:
**§2a**, a convention change that landed mid-build and changed part of the
row model from what §4–§5 originally specified.

## 1. What this tool answers

Unchanged from the options document: without reading the code, which parts of
the product own which tests, and which parts are thin. See
[coverage-reporting-options.md §Goal](coverage-reporting-options.md) for the
full argument. The shape that answers it, settled in
[testing-decisions-wip.md §"What the explorer shows"](testing-decisions-wip.md),
is a table, not a drill-down pyramid and not a treemap:

> Rows are parts of the product. Columns are counts, not states.

## 2. What changed since the options document, and why the POC is not the base

The options document's preferred design (decision 1.4/2.3/3.3, implemented in
the POC) does two things this spec drops:

1. **It renders a state per cell** (met / partial / required-and-absent / not
   applicable) for every node crossed with every level. Settled discussion
   found this wrong: a rule lives at exactly one level, wherever the lowest
   level able to prove it turns out to be. "Actions owes an integration test
   and a unit test" isn't a real obligation, so there is nothing to mark
   absent. The table holds **counts** per level instead, with two coverage
   columns (files nothing runs, branches nothing takes) that *are* real zero/
   nonzero facts.
2. **It infers obligation from three structural signals** (branch count,
   purity, fan-in) to decide whether a node owes a test at all. That inference
   step is no longer needed for the main table, because obligation is no
   longer what the table shows — only what exists. The three-signal machinery
   in `poc/coverage-explorer/src/policy/obligations.js` is **not carried
   forward**. What survives from that layer is plain branch/statement
   coverage (which branches nothing takes, which files nothing runs), which
   is a measurement, not an inference.
3. **Nodes come from four structural sources** (workspace globs, layer
   folders, connector packages, `commandSchemas`) with the product concept
   only a secondary axis for the F3 capability rows. Settled discussion
   inverts this: the product concept is the **primary** row axis for the
   whole table, derived from a checked-in concept registry (§5), not from the
   four structural sources. This is the amendment
   [testing-decisions-wip.md §"Still open"](testing-decisions-wip.md) flagged
   as owed to the options document.

What the POC gets right and this spec keeps: the `model.js` contract
separating derivation from rendering, deriving from artifacts the repo already
maintains rather than a hand-authored tree, and reading test files rather than
running them so the report doesn't depend on the suite being green.

## 2a. A convention change that landed mid-build, and what it broke

§4–§5 below were written against the dotted `concept.subaction` describe
convention (`item.capture`, `command.idempotency`) that
[testing-decisions-wip.md](testing-decisions-wip.md) described at the time.
By the time the test-alignment branch actually merged
([PR #51](https://github.com/michaelvanhoutte/cockpit/pull/51)), that
convention had been reconsidered and replaced —
[testing-strategy.md §9.1](testing-strategy.md) is now explicit that the outer
`describe` is an **undotted feature area**, not a dotted entity:

> `item.setStatus`, `command.idempotency` and `item.change` all name an object
> or a function rather than a part of the product, and a statement list built
> from those cannot be read as a description of what the app does.

The real tests use `Capture`, `Triage`, `Offline`, `Associations` — words a
person would use to describe the product, cross-referenced against the
Glossary in [functional-definition.md §14](functional-definition.md). This was
anticipated by the doc itself: testing-decisions-wip.md's own note on the
change says plainly that "the POC is untouched and its splitting logic needs
updating before it is relied on again" — this section is that update, applied
to the real build rather than the POC.

**The mechanical fix** (§6.2): the concept is the outer describe's text
verbatim, no `.`-splitting. `analyze/rules.js` and the `Rule` type in
`model.js` were updated accordingly.

**The structural consequence, which is bigger than a rename.** A dotted
entity name gave every rule a natural, near-exclusive owner: `item.*` rules
are about `items.ts`. A feature area does not — `apps/api/src/domain/items.ts`
contains `captureItem` (backs `Capture`), `applySetStatus` and
`applySnoozeUntil` (back `Triage`, and `Offline`'s stale-write rejection), all
in one file, verified directly in the merged
[items.test.ts](../apps/api/tests/unit/domain/items.test.ts). §5's original
invariant — "every source file matches exactly one concept, checked in CI" —
assumed the dotted-entity shape and is not a coherent rule once one file
legitimately backs several feature areas. Two things changed to accommodate
this, both implemented and validated against the real repo:

1. **Multi-membership is now allowed and expected.** `concepts.json`'s
   `sourcePatterns` can, and routinely do, overlap across areas. A file
   matching zero areas still falls into the implicit `infrastructure` bucket,
   unchanged from §5's original design — only the "at most one" half of the
   invariant is gone.
2. **`--check-concepts` (§7) changed what it gates on.** With file-overlap no
   longer an error, there was nothing left for that check to reject. It now
   fails the build when a test declares a feature area that isn't in
   `concepts.json` — the same *kind* of guarantee (a typo or a forgotten
   registry entry fails CI with a one-line fix), anchored to describe names
   instead of file patterns, which is arguably the more direct check of the
   two: it catches the exact mistake a human is likely to make (writing
   `describe('Trige', ...)`) rather than a downstream symptom of it.

**A second, unrelated finding surfaced by running this against the real
suite, also fixed:** `apps/api/tests/integration/http/item-changes.test.ts`
drives the real Worker over HTTP (`SELF.fetch` from `cloudflare:test`) rather
than importing `http/command-service.ts` or `db/repo.ts` directly — exactly
the testing-strategy-mandated "enter through the real interface, not around
it" pattern. "Files nothing runs" (§6.3) is import-reach only, so it cannot
see that HTTP-mediated exercise and reports those two files as untested —
false positives on precisely the file the original coverage audit called the
single highest-value gap in the codebase
([coverage-reporting-options.md, "Current state"](coverage-reporting-options.md)).
Rather than build a heuristic to paper over it (risking new false negatives
elsewhere), `analyze/index.js` detects any test importing `SELF` from
`cloudflare:test` and emits one explicit warning naming the limitation, so a
reader is told to verify before treating a hit in that column as real —
instead of silently trusting a wrong signal on the one file it matters most
for.

## 2b. Code review findings, fixed

A multi-angle review of the diff (`/code-review --fix`) found and fixed nine
real issues, all now covered by the test suite added as part of the same
pass (§9 step 9):

- **`--check-concepts` had a false negative.** `extractRules` drops an empty
  describe (no cases written yet) before it ever becomes a `Rule`, so a
  typo'd area with no cases — the exact scaffolding moment the check exists
  to catch — passed silently. Fixed by feeding the check every describe name
  seen (`areasSeen`), not just ones that produced a rule; `concepts.js`'s
  `unregisteredAreas` (previously written but never called) is now the one
  place that logic lives.
- **`describe.skip(...)`/`.only(...)` at the top level silently dropped the
  whole area**, inconsistent with `it.skip` already counting as a real case.
  Fixed by recognizing the modifier forms in `describeCall`.
- **`markReached` missed per-specifier `type` imports** (`import { type X }`,
  as opposed to a whole-declaration `import type {...}`), which could mark a
  file "reached" that TypeScript actually elides at compile time. Fixed by
  checking each named specifier's own flag, not just the declaration's.
- **`branchesNotTaken` only caught branches where every path was untaken**,
  missing the common case (an `if` with no `else`, tested only on the taken
  side). Currently dormant — no coverage config exists yet (§6.3) — but would
  have silently under-reported the moment one landed. Fixed to check each
  path of a branch independently.
- **The Infrastructure row leaked a stray sub-label** in the detail panel,
  the exact "dotted entity" artifact §2a's redesign was meant to eliminate —
  caused by `INFRASTRUCTURE_KEY`/`INFRASTRUCTURE_LABEL` differing only in
  casing. Fixed by dropping the now-pointless secondary label entirely (every
  real area already has `key === label`).
- **`hasConnector()` was a hardcoded stub** ignoring the `packages` data
  `analyze()` already computes, meaning a real connector package would never
  make the Contract column light up without a manual code change. Fixed to
  derive from a concept's (currently always-empty) `connectors` field checked
  against real workspace packages.
- **The Infrastructure row's label was computed twice** — once correctly in
  `withInfrastructure`, once redundantly in `index.js`'s row-mapper. Fixed by
  deleting the redundant copy.
- **The HTTP-reach warning (§2a) was global and hardcoded** to its original
  example file names rather than naming whichever test(s) actually triggered
  it, so it wouldn't have stayed accurate as more HTTP-driven tests were
  added. Fixed to list the actual triggering file(s).
- **Each test file was parsed into a fresh AST three times** per analysis run
  (once each in `extractRules`, `importsSelfFetch`, `markReached`), tripling
  the tool's dominant cost for no reason. Fixed by parsing once per test file
  in `index.js`'s loop and passing the shared `source` into all three.

A tenth finding — **the package shipped with zero tests**, a real violation
of [testing-strategy.md §5](testing-strategy.md)'s "new logic ships with L1
tests in the same change" — is the reason §9 step 9 exists.

## 2c. First real use: rows became a tree, columns became the real six levels

Michael's first pass using the built page raised seven things, all addressed
in the same round:

1. **Rows needed to be a tree, not a flat list.** A big area like Dashboards
   is going to have real sub-areas (drag-drop, resizing, ...) once it has
   tests, and a flat list can't show that without either cramming everything
   into one row or renaming every test's `describe` every time the shape
   gets reorganized. Fixed with the smallest change that doesn't touch the
   describe convention at all: an entry in `concepts.json` can carry an
   optional `"parent": "<key>"` (§5), and `analyze/concepts.js`'s `buildTree`
   turns the flat registry into a real tree from those pointers, with cycle
   detection (a parent chain that loops back on itself becomes roots with a
   warning, rather than both nodes silently vanishing from the render — a
   real bug caught before it shipped: two nodes pointing at each other left
   neither in `roots`). Nothing needs adding today — nothing has grown a real
   sub-area in tests yet — but the mechanism is there and covered by five
   tests in `concepts.test.js`.
2. **Not every node needs every column populated, and that's fine as
   presented.** A leaf will typically carry only L1/L2 (or F1/F2); F3 will
   typically sit on whichever ancestor's test exercises the whole subtree.
   Considered and rejected: guessing per-node "applicability" (e.g. "leaves
   never get F3") and rendering those cells as n/a. That would be a real
   regression to the state-inference model §2 already dropped once, and
   Michael's own words — "I don't know if these are the right child
   levels" — argue directly against baking in a structural guess. What ships
   instead: real per-node counts, honestly zero where nothing is authored
   there, with the tree itself supplying the context (a 0 at a leaf next to
   a populated ancestor row reads correctly once both are visible together).
3. **Six-plus-one columns, not three.** The table was quietly collapsing two
   testing-strategy levels into each of "Backend" and "Frontend" (L1+L2,
   F1+F2) and dropping L3 entirely. `analyze/rules.js`'s `levelForTestFile`
   now maps a test file straight to one of the seven real columns
   (L1/L2/L3/F1/F2/F3/Contract — `model.js`'s `LEVELS`), and `Rule.level`
   carries that instead of the old coarser `column`/`level` pair. **L3 is
   n/a everywhere today**, not zero: it only means anything once a second
   backend service exists to wire together (testing-strategy.md §2), derived
   from real workspace data (`Model.availableLevels.L3`, true once more than
   one package has a `wrangler.jsonc`/`.toml`/`.json`) rather than hardcoded
   — the same pattern Contract's per-node n/a already used for "no connector
   package yet."
4. **Rule rows were too small to scan, and file references weren't links.**
   Both are render-only fixes (`render/client.js`, `render/styles.css`):
   bigger type and padding on each rule card, and every `file:line` a real
   `<a href>`. The relative path is computed in `cli.js` — `path.relative`
   from the report's own output directory back to the repo root — and passed
   into `renderHtml` as `repoRelPrefix`, kept out of the Model itself since
   "where will this be opened from" is a render concern, not something
   `analyze/` can know (§6.1's split).
5. **"Branches nothing takes" was a bare number with a location, and that
   wasn't enough to act on.** `analyze/index.js` now reads the actual source
   line at each untaken branch's location and carries it as `snippet` on the
   `BranchRef`, so the panel shows `ItemRow.tsx:47` next to
   `{item.snoozedUntil ? ... : ''}` directly — no need to open the file to
   know what the gap even is. A persistent "How to read this" legend was
   added to the page itself (not just column-header tooltips) explaining
   both coverage columns and all seven level columns in one sentence each,
   since a number with no explanation anywhere on the page was the
   complaint, and a hover-only tooltip doesn't fully answer "I don't
   understand this column."
6. **The commit should link to GitHub.** `analyze/index.js` now derives a
   `commitUrl` from the `origin` remote (handles both the `https://` and
   `git@` remote URL forms) plus the full SHA, null when the remote isn't
   GitHub or can't be read (e.g. the fixture-repo tests, which aren't inside
   a `.git` checkout at all — covered explicitly in `index.test.js`).
7. **Same root cause as (5) for "files nothing runs".** Now covered by the
   same legend entry, and every path in the list is a link for the same
   reason rules got them.

## 2d. Second-look feedback: a real panel, case-level detail, an inline viewer

Michael's second pass, after actually clicking around the §2c version, raised
five more things:

1. **The tree was still empty in practice** — nothing in the registry
   actually nests, so the mechanism from §2c point 1 had never been seen
   rendering. Fixed by adding `Drag-drop` and `Resizing` as children of
   `Dashboards` in `concepts.json`, both empty-pattern placeholders (same
   convention as any not-yet-built area) explicitly marked in the registry's
   own comment as a demonstration, not a real taxonomy call — free to rename
   or delete the moment a real sub-area is known.
2. **The panel was a narrow sidebar with three sections stacked vertically**,
   so reaching "files nothing runs" or "branches nothing takes" meant
   scrolling past the whole rules list first — exactly backwards from
   "difficult to find." Fixed with a real restructure, not a CSS tweak: the
   panel is now three **tabs** (Rules / Files nothing runs / Branches
   nothing takes), each showing only its own content, so any one is one
   click away regardless of how long the others are. Along the way, a real
   layout bug got caught and fixed: the two sides of the explorer shared one
   outer `.card`, so its background stretched to match whichever side was
   taller, leaving visible dead space under the shorter one — split into two
   independently-sized cards.
3. **The panel was also just narrow** (a 460px fixed sidebar) despite being
   where all the actual reading happens. The grid now gives the tree a
   bounded, comfortable width (`minmax(560px, 46%)`) and the panel
   everything else, sticky positioned so it stays in view — "a large panel
   on the right," not a sidebar — and the page's own max-width grew from
   1440px to 1900px, since the previous cap was leaving real horizontal
   room unused on anything wider than that.
4. **"I can see 'a complete capture is accepted', but I can't request more
   details — I still don't really know what exactly is tested."** A `Rule`
   used to carry only case *counts* (`cases: number`). It now carries each
   case's own text and location (`cases: CaseRef[]`, `rules.js`'s
   `collectCases`) — the individual `it(...)` description, printed the same
   way the runner itself would (per testing-strategy §9.1's "the runner
   prints the statement list itself"). Building this surfaced a real,
   separate bug, not just a data-shape change: `it.each(table)(name, fn)` is
   two chained calls, and the naive AST match (mirroring how `it.skip`/
   `.only` are matched) was matching the *inner* call — `it.each(table)`
   alone — reading the entire data table as one case's "name." Fixed with a
   dedicated check for the chained-call shape; regression tests for both
   `it.each` and `test.each` are in `rules.test.js`. (The tagged-template
   form, `` it.each`...`(name, fn) ``, still isn't recognized — not used
   anywhere in this repo today, and out of scope for this pass.)
5. **"When I click on a file path, I see the file rendered in this page ...
   and I can click somewhere there to go to the actual source."** Every
   file:line reference anywhere in the model — a rule's own describe line, a
   case's `it(...)` line, a branch gap, now even a whole-file "files nothing
   runs" entry (its first few lines) — is a `CodeRef` carrying a `context`:
   a small window of real source lines read at analyze time
   (`analyze/index.js`'s `contextAt`, cached per file so a file referenced
   many times is only read once). In the browser, the file:line is a button,
   not a plain link: clicking it toggles an inline, line-numbered code block
   open in place, target line highlighted, with two real links inside it —
   "Open on GitHub" (preferred: a `#L<line>` anchor built from `commitUrl`,
   jumping straight to the line, viewable without a local checkout at all)
   and "Open file" (the local relative link, as a fallback when the repo
   isn't on GitHub or the remote couldn't be read). Caught one real bug
   while wiring this up: the page's embedded model payload never included
   `commitUrl` at all — the GitHub link would have silently never appeared.

## 2e. Where a row comes from, vs. where its counts come from

A fair question after §2d point 1: if the tree comes from `describe`
blocks, how can `Drag-drop`/`Resizing` show up with zero tests behind them?
It doesn't, and they didn't (§2d's demo nesting is removed as of this
section — see below) — the confusion is worth resolving precisely, because
it's easy to conflate two different things this tool does:

- **Which rows exist at all is registry-driven**, not test-driven. Every
  entry in `concepts.json` becomes a row, `parent` and all, whether or not
  any test names it — this was already true of `Dashboards`/`Panels`/
  `Focus`/etc. since §5's very first version (declared "ahead of the code,"
  staying at zero until real tests land). §2c's `parent` field is the same
  idea one level deeper: it lets a row nest without needing a test to exist
  first.
- **What populates a row is test-derived**, without exception: every count,
  every rule, every case, every coverage gap comes from real `describe`/`it`
  blocks, real import graphs, real coverage data. Nothing in that half is
  ever invented.

§2d's `Dashboards` → `Drag-drop`/`Resizing` nesting was a real instance of
the first kind — two rows added purely to prove the tree UI renders
correctly, with nothing in the second kind (no test, real numbers all zero,
exactly like `Dashboards` itself). Once confirmed working, both were
removed: leaving an invented row sitting in the real registry — even a
correctly-zeroed one — cuts against the tool's whole point, which is
deriving structure from what actually exists rather than hand-authoring it
(the same reasoning [coverage-reporting-options.md](coverage-reporting-options.md)
gives for rejecting a hand-maintained tree in the first place). The
mechanism stays exactly as built; `concepts.json` is flat again until a
real feature area's tests justify a `parent`.

`tools/test-explorer/README.md` now exists specifically to make this
distinction explicit for anyone reading the registry cold, rather than
relying on this spec doc alone.

## 2f. Third-look feedback: a misleading mark, a real overlay panel, drill-down

Four more things from a third look at the rendered page:

1. **The green ✓ next to a case looked like a pass/fail result.** It isn't,
   and can't be — this tool never runs the suite (§2, from the very start:
   "a report that needs the suite to run is a report that stops working the
   moment the suite breaks"), so a checkmark next to a case was claiming a
   fact the tool has no way to know. Removed. A written case is now shown
   with no mark at all; only "not written yet" (a `.todo`) gets a visible
   badge, because *that* is a fact the AST genuinely does know.
2. **A `.each` case showing its raw template (`$situation`) instead of what
   was actually tested** was flagged with two real examples. Fixed properly
   rather than papered over: `rules.js` now statically evaluates the
   `.each(table)` array when it's a literal, and substitutes each row's real
   value into the template's `$key`/`$a.b` and `%s`/`%d`/`%j`/`%o`/`%#`-style
   placeholders — `'$situation'` against
   `{ situation: 'without a request id', capture: {...} }` renders as
   *"without a request id"*. Resolution is deliberately per-property, not
   all-or-nothing: the real case that prompted this
   (`packages/shared/tests/unit/commands.test.ts`) has a `capture` sibling
   property built from `uuidv7()`/`new Date()` — calls, not literals — and
   that must not stop the *sibling* `situation` property (a plain string)
   from resolving. A placeholder nothing can resolve is left exactly as
   written rather than guessed at, and a table that isn't a literal array at
   all (built from a variable or a function call) falls back to one case
   with the raw template, same as before this existed. Five new tests in
   `rules.test.js` cover the resolution, the partial-property case
   specifically, `%j`/`%o`/`%#`, an unresolvable placeholder, and the
   non-literal-table fallback.
3. **"I lose half the screen above Capture that I could also use to show
   tests."** The panel was `position: sticky` *inside* the page's own
   document flow — which meant on load, before any scrolling, it only had
   whatever viewport space was left below the masthead/legend/warnings. Its
   own vertical size was never the problem; **its position was.** Fixed by
   making it a true `position: fixed` overlay pinned to the browser
   viewport's right edge, `top: 0` to `bottom: 0` — the full screen height,
   always, regardless of scroll position or how tall the header content is.
   `body` reserves the panel's width with `margin-right`, so the rest of the
   page (including the tree) reflows to the left of it rather than running
   underneath. Below 1000px wide, the overlay would crush the tree
   unreadably thin, so it falls back to a plain stacked block instead —
   full-page master-detail only makes sense once there's room for both
   sides. (One thing worth recording: verifying this needed
   `getBoundingClientRect()` after a real `scrollTo()`, not a screenshot —
   the preview tool's screenshot capture during/after a scroll was
   momentarily stale on more than one occasion this session, and looked like
   a layout bug that direct DOM measurement showed wasn't one.)
4. **"I would like the Capture list to show all tests when I click on
   Capture, but only L1 when I click on L1... and Files/Branches nothing
   runs/takes should open when I click that number."** Every count cell in
   the tree is now independently clickable, not just the row: clicking a
   level's count selects that concept, opens the Rules tab, and filters it
   to that one level (a dismissible chip — "Showing L2 only" — makes the
   filter visible and reversible); clicking the concept's own name shows
   every level; clicking "files nothing runs" or "branches nothing takes"
   jumps straight to that tab. `client.js`'s single generic row-click
   handler was replaced with one handler per cell, since each now means
   something different — there is no longer one "select this row" action,
   only cell-specific ones.

## 2g. Fourth-look feedback: sorting rules by level, a title/location swap, and "how do I act on this"

Four more rounds folded into one, from continued real use:

1. **"Sort the listed tests under Capture as L1, L2, L3, F1... and make the
   distinction clearer."** The Rules tab now groups its cards under a
   `.levelhead` heading per level ("L1 · UNIT (3)"), in the fixed level
   order from `model.js`'s `LEVELS`, instead of one flat list with a small
   per-card badge that was easy to miss. This replaced the per-card badge
   entirely rather than keeping both — one place to see the level, not two.
   A genuine table (one row per case, columns for level/statement/location)
   was considered and rejected: a rule's statement is prose that doesn't
   compress into a cell, and the real relationship is one rule to *many*
   cases, which a flat table row-per-case either loses (collapsing cases) or
   multiplies awkwardly (repeating the rule text per case row). Grouped
   cards keep that one-to-many shape visible without either problem.
2. **"I wonder if it makes sense to swap the title and the first file
   path."** The rule card led with the file:line location, statement below
   it — but the location is metadata, not the point; the statement is what
   the row is actually about. Swapped: `.r-text` (the statement) now leads,
   `.r-loc` (file:line) follows at reduced opacity as a secondary line.
3. **A "list missing tests" column, considered and rejected.** The idea —
   an LLM-suggested list of tests that don't exist yet, shown as a column
   next to the real counts — was floated, then self-questioned in the same
   message: a dismissed suggestion has nowhere to go, so it would just
   reappear every regeneration with no way to mark "I looked at this and
   decided not to." Recommendation was to keep it out of the report
   entirely, for a reason that predates this specific idea: every number
   and word on this page is a measured fact about the repository as it
   exists right now (§2's founding constraint), and an LLM's opinion about
   what's *missing* is neither measured nor a fact — it doesn't reproduce,
   two runs could disagree, and mixing invented content into a page whose
   whole value is "you can trust every cell" would quietly undermine that
   trust for the real cells too. The repo already has a purpose-built place
   for turning fuzzy scope into a reviewable statement list — the `scoping`
   skill (root `CLAUDE.md`) — and duplicating a worse version of it inside
   a static report was judged worse than not having the feature.
4. **"I have a list of branches and files not tested, but I don't have a
   good way to act on this."** Rejected as a solution: triggering an LLM
   call *from the report itself* to suggest tests — that's the same
   invented-content problem as point 3, just moved one level down (per-gap
   instead of per-area), and a static HTML file has no business making API
   calls on its own. What shipped instead is two things, both built from
   data the Model already has, nothing new invented:
   - **An always-visible gap summary.** `renderPanel()` now shows a
     `.p-gapline` — two small pills ("3 files nothing runs", "0 branches
     nothing takes") right under the concept name, above the tab bar, so
     the gap counts are visible regardless of which tab is open, and
     clicking either jumps straight to that tab. Deliberately *not*
     attempted: tying a specific file or branch gap to the specific rule
     it's "missing from." The analyzer has no per-rule import-tracing
     today (only per-area), so any such link would be a guess dressed up
     as a fact — exactly the thing point 3 ruled out.
   - **"Copy prompt to write a test."** Every entry in the Files/Branches
     tabs now has a button that assembles a ready-to-paste prompt —
     `fileGapPrompt()` / `branchGapPrompt()` in `client.js` — from real
     Model data only: the file path and line, the actual source snippet
     already shown inline (`contextText()`), the feature-area label, and a
     pointer to follow this repo's testing skill/strategy (lowest level
     that proves the behavior, product-language naming). No suggestion of
     *what* the test should assert is generated — that reasoning stays
     with whoever pastes the prompt into a real agent session, which is
     where "act on this" actually happens. `copyToClipboard()` tries
     `navigator.clipboard.writeText` and falls back to a visible,
     auto-selected `<textarea readonly>` when clipboard access isn't
     available (confirmed via the browser tool, which runs without
     clipboard permission) — never a silent failure.
     (Revised the next round — see §2h: the per-gap button and its embedded
     snippet did not survive real use.)

## 2h. Fifth-look feedback: the gap line was redundant, and the copy-prompt design was wrong

Three corrections, all from the very next look at §2g's own output:

1. **"The gapline pills and the tab labels say the same thing twice."**
   Right — once §2g's Rules/Files/Branches tabs started carrying their own
   counts, the always-visible `.p-gapline` chips above them (added in §2f
   for a different reason: making the counts visible *before* the tabs
   existed) were pure duplication. Removed `gapChip()` and `.p-gapline`
   outright rather than trimming one of the two.
2. **"I still don't see much contrast change"** — after §2f's ink-3 lighten
   and §2g's opacity removal, the actual complaint was never about text
   color; it was structural: level groups and individual cards weren't
   visually *separated*, no matter how bright their text was. Fixed with
   layout, not color: `.levelhead` gained a 2px bottom border and more
   surrounding margin so a new level group reads as a section break, not a
   label; `.rule` cards moved from a background four units darker than the
   panel (imperceptible) to visibly lighter with a brighter border and a
   shadow, so consecutive rules read as distinct blocks; and multiple cases
   under one rule now get a dashed divider between them (`.case + .case`),
   so a rule with six cases doesn't read as one paragraph.
3. **The per-gap "Copy prompt to write a test" button, rejected after
   actually being used.** The concrete objection: "I am simply copy pasting
   some random code right now that I don't know what it's for and what it
   does and I am asking to write a test covering I don't know what." That's
   a real flaw, not a misunderstanding — `fileGapPrompt()`'s embedded
   snippet was, for almost any file, just its `import` lines; nowhere near
   enough to judge whether a test is warranted, let alone what it should
   assert. Showing the *real* file instead was considered and also
   rejected, by the user directly: an agent opening the file still needs
   the same judgment call repeated once per gap, which doesn't scale when a
   concept has a dozen of them. What replaced both: `allGapsPrompt(node)`
   builds **one prompt per concept**, listing every file and branch gap it
   has as plain paths (no snippets, no per-item buttons, no `fileGapPrompt`/
   `branchGapPrompt`/`contextText` — all removed) with one closing
   instruction: use this repo's test strategy and guidance to figure out
   which of them actually need a test. The judgment call moves entirely to
   whoever pastes the prompt into a real session — closer to how the
   `scoping` skill already works, just scoped to one concept's gaps instead
   of a whole feature. `copyPromptAction()` gained a `label` parameter so
   the panel header's single button ("Copy prompt for missing tests") and
   any future caller can each set their own text.

## 2i. Code review findings, fixed (three real bugs, one found while fixing another)

`/code-review` (Claude's automated PR review) on the first open PR found three things, all confirmed real and fixed:

1. **`tests/unit/index.test.js` did real filesystem I/O** (`mkdtempSync`/
   `writeFileSync`/`rmSync` to build a synthetic fixture repo) — a clear
   violation of the testing skill's L1 dependency rule ("L1/F1 may not
   touch: filesystem, network, ..."). The orchestrator genuinely needs a
   real file tree to exercise meaningfully, so the fix wasn't to fake the
   filesystem; it was to admit this is an L2 test and move the whole file
   to `tests/integration/index.test.js`, and give `package.json` the same
   `test:unit` (scoped to `tests/unit`) / `test:integration` (scoped to
   `tests/integration`) split apps/api already uses.
2. **`model.js`'s `summarise()` double-counted shared files.** `concepts.json`
   deliberately lets one source file belong to more than one feature area
   (§2a/§5 — `apps/api/src/db/repo.ts` backs four areas), so a plain sum of
   `filesNothingRuns.length`/`branchesNothingTakes.length` across every tree
   node counted that file's gap once per area it belongs to — the masthead
   read 29 "files nothing runs" against a true count of 21 unique files.
   Fixed by deduplicating with a `Set` (by file path for files, by
   `file:line` for branches) before counting; `tests/unit/model.test.js` is
   new, since `summarise`/`walkTree` had no direct coverage before this.
3. **`coverage.js`'s `branchesNotTaken()` returned `[]` for a file with no
   coverage data at all**, indistinguishable from "measured, genuinely zero
   untaken branches" — the same "missing measurement must never look like a
   clean one" invariant `model.js` documents for the workspace-wide
   `coverageAvailable` flag, just silently violated one file at a time. A
   file excluded by a package's coverage config (every package excludes
   `**/index.ts`) or owned by a package with no `test:coverage` script
   (`packages/connector-sdk` today) would render a false, confident "0."
   Fixed by returning `null` for "not in the map at all" instead of `[]`,
   and having `analyze/index.js` collect every such file across the run
   into one named warning (the same pattern already used for the
   HTTP-driven-test false-positive on "files nothing runs") rather than
   silently folding them into a real zero.

   Fixing (3) surfaced a fourth bug it would otherwise have hidden:
   **`branchesNotTaken` looked files up with `map.data[absFile]` directly,
   which assumes every provider writes the same path-separator convention
   Node's `path.join` uses on the current platform.** On Windows that's
   true for the v8 provider (apps/web, packages/shared) but not for
   istanbul (apps/api, instrumenting inside the Workers pool), which writes
   forward-slash paths regardless of platform. Before this PR the mismatch
   was invisible — a failed lookup returned `[]`, identical to a genuine
   zero — so apps/api's entire "branches nothing takes" column was silently
   wrong on Windows from the moment coverage landed, and nothing caught it.
   Turning the failure mode from `[]` into `null`-plus-a-warning (fix 3)
   made this visible immediately: a real report on this machine warned
   about fifteen apps/api files that were, in fact, genuinely instrumented.
   Fixed by matching on a separator-normalized key instead of the raw path
   (`coverage.js`'s `normalizedKeys()`, memoized per map since the same map
   is queried once per file per concept). Confirmed against the real repo:
   the warning list dropped from those fifteen false positives down to the
   six files that are actually unmeasured (five `index.ts`-shaped
   exclusions plus one file, `apps/api/src/env.ts`, genuinely never
   imported by any test).

## 2j. Code review findings, round two

Pushing §2i's fixes triggered a fresh `/code-review` pass against the new commit, which found three more real issues — two of them CLAUDE.md/testing-skill violations (new pure logic shipped with no L1 test, which the skill states unconditionally must ship in the same change) rather than logic bugs:

1. **`rules.js`'s `levelForTestFile` regex couldn't match a connector package's own unit/integration tests.** `packages\/[^/]+\/tests\/` allows exactly one path segment between `packages/` and `/tests/`, matching `packages/shared/tests/...` but not `packages/connectors/gmail/tests/unit/...` (two segments: `connectors`, `gmail`). The `Contract` branch immediately above already accounted for the extra segment (`packages\/connectors\/[^/]+\/tests\/contract\/`) — this was a real oversight, not intentional scoping, and the comment directly above the buggy line already claimed `packages/connectors/*` was covered. Latent today (no `packages/connectors/` directory exists yet) but would silently misbehave — the file skipped, its `describe`s never reaching `allAreasSeen`, `--check-concepts` blind to a typo inside it — the moment a real connector package landed, since `pnpm-workspace.yaml` already globs `packages/*`. Fixed by extending the regex to `packages\/(?:connectors\/)?[^/]+\/tests\/`; two new tests in `rules.test.js` cover a connector's unit and integration test paths.
2. **`cli.js`'s new `parseArgs` shipped with no test.** It's exactly the branchy, dependency-free logic the testing skill's decision ladder routes straight to a unit test — every sibling module in this package (`concepts.js`, `coverage.js`, `rules.js`, `model.js`) already has one; `cli.js` was the one exception. The blocker was `parseArgs` calling `process.exit(2)` directly on an unrecognized flag, which would kill the test runner rather than let a test observe the behavior — fixed by making `parseArgs` pure (`{ unknown: a }` returned, not thrown or exited) and moving the actual `process.exitCode`/stderr write into `main()`, which already returns exit codes for every other branch. `tests/unit/cli.test.js` is new. Exporting `parseArgs` surfaced a second, separate problem: `cli.js`'s bottom line unconditionally called `main(process.argv.slice(2))` at *import* time, with no guard — merely importing the module to test `parseArgs` would also run the real CLI against the test runner's own `process.argv`. Fixed with the standard `import.meta.url === pathToFileURL(process.argv[1]).href` entry-point guard (not a raw `file://` template string, which mishandles Windows drive-letter paths).
3. **`render/html.js`'s new `esc`/`jsonScript` shipped with no test**, despite being pure, dependency-free, and directly security-relevant (HTML-escaping and the `<`/U+2028/U+2029 script-injection-safe JSON serialization used to embed the model in a `<script>` tag) — precisely the property worth asserting directly rather than trusting to manual review. Exported both and added `tests/unit/html.test.js`.

Fixing (2) hit one unrelated snag worth recording: `cli.js` carried a `#!/usr/bin/env node` shebang from the start, never actually needed since every caller (`package.json` scripts, the README, CI) invokes it as `node src/cli.js`, never as a standalone executable. Vitest's transform pipeline failed to parse the file with a `SyntaxError: Invalid or unexpected token` the moment something imported it as a non-entry module (`cli.test.js`) — Node's own loader and esbuild each handled the shebang fine in isolation, so this looks like a vite-node-specific interaction, not investigated further since the shebang was dead weight anyway. Removed it; the failure went away.

## 3. The test-folder migration (done)

The row/column model in §4 depends on two conventions:

- tests physically separated into `tests/unit/`, `tests/integration/`, etc.,
  per package (per [testing-strategy.md §9](testing-strategy.md)) — the level
  a test belongs to is read from its folder, not inferred;
- the outer `describe` block names a feature area (§2a) — the area a rule
  belongs to is read from that block's text directly.

Both are true of `main` as of `0897f91`: `apps/api/tests/{unit,integration}/`,
`apps/web/tests/unit/`, and `packages/shared/tests/unit/` all exist with
per-package `vitest.config.ts` files, and every outer describe across all six
merged test files uses the feature-area convention. The tool was built and
validated (§9) against this real state directly — no fixture or read-only
worktree needed once this landed.

## 4. Data model

### 4.1 Rows: a tree of feature areas

A checked-in **area registry** (§5) lists every feature area: a key (equal
to its display label — see §2a, there is no dotted entity name to display
separately anymore), the source-file glob patterns it owns, and an optional
`parent` (§2c) that nests it under another entry. `Capture`, `Triage`,
`Offline`, `Associations`, `Dashboards`, `Panels`, `Focus`,
`Connector management`, `User management` are the nine root areas seeded
from [testing-strategy.md §9.1](testing-strategy.md)'s own example list, and
`Sign-in` is the first added since, on the day the product grew a behaviour
the nine had no word for — nothing restricts the registry to exactly those,
or to being flat; it grows areas and children as real ones show up in tests. Backend plumbing that no
area owns (the event stream, tenancy, app wiring — code testing-decisions-wip
says stays whole rather than splitting by feature) lives under an implicit
`infrastructure` bucket, always a root, not left unmatched. Rows are the
resulting tree, one node per registry entry, `Infrastructure` always last
among the roots.

A node's counts and rules are **its own only** — a parent with children does
not sum their totals into its own row. The tree structure itself is what
shows the relationship; see §2c point 2 for why a rolled-up "subtree total"
was considered and rejected.

### 4.2 Columns

The seven columns are `model.js`'s `LEVELS`, in testing-strategy's own order
— the actual six levels (§2, §3.3) plus Contract, not a coarser grouping:

| Column | Source | Meaning |
|---|---|---|
| L1 | `apps/api/tests/unit/`, `packages/*/tests/unit/` (excluding connectors) | count of rules whose outer describe matches this area's key |
| L2 | `apps/api/tests/integration/`, `packages/*/tests/integration/` | count |
| L3 | `apps/*/tests/system/` (no folder exists yet) | count, or `n/a` for every row when the workspace has only one backend service — see §2c point 3 |
| F1 | `apps/web/tests/unit/` | count |
| F2 | `apps/web/tests/service/` | count |
| F3 | `tests/e2e/` at the repo root | count (Playwright spells the same two-level structure `test.describe`; see rule extraction, §6.2) |
| Contract | `packages/connectors/*/tests/contract/` | count, or `n/a` for any area with no connector package |
| Files nothing runs | — | source files matching this area's patterns that no test file (at any level) imports directly — a real limitation for HTTP-driven integration tests; see §2a |
| Branches nothing takes | — | merged branch coverage (§6.3) restricted to this area's files |

No percentage anywhere, including as a secondary number, per the settled
design's explicit reasoning: once one exists it becomes the thing people look
at, and it is the one number here that can rise without proving anything. A
persistent legend on the page itself explains every column in one sentence
(§2c point 5) — not left to a hover tooltip alone.

### 4.3 Selecting a row: three tabs, not one stacked panel

Per §2d point 2, the three things below are tabs — Rules / Files nothing
runs / Branches nothing takes — not sections stacked in one scroll, so any
one is reachable in one click regardless of how long the others are:

- **Rules**: every rule counted in that row's own L1–Contract cells, as its
  inner-describe statement, with which level it sits at; each of its cases
  (and todo cases) with their own text (§2d point 4) — what the runner would
  actually print, not just a count.
- **Files nothing runs**: every source file matching this area's own
  registry patterns that no test imports, restricted to this node (not its
  children).
- **Branches nothing takes**: every branch gap restricted to this area's own
  files, from merged coverage (§6.3).

Every file:line anywhere in these three tabs — a rule's own line, a case's
line, a branch gap, a whole-file gap — is a real `CodeRef` (§2d point 5):
clicking it toggles an inline, line-numbered window of real source open in
place (read at analyze time, cached per file — `analyze/index.js`'s
`contextAt`), with a link to open the actual file (GitHub when the report
knows its commit, a local relative link as fallback — computed by `cli.js`
knowing the report's own output location, never stored in the Model —
see §6.1).

No "reason for the level" field is computed or asked for at this stage — the
level is read mechanically from which `tests/<level>/` folder the file sits
in, and *why* a rule sits at that level is a call the author already made
when placing the file. Capturing the one-clause reason as a comment or a
convention is worth doing but is a testing-strategy concern
([testing-strategy.md §1](testing-strategy.md)), not something the explorer
computes or blocks on.

## 5. The area registry

One checked-in file, `tools/test-explorer/concepts.json` (filename kept from
before §2a for continuity; the content is areas, not dotted concepts), each
entry:

```json
{
  "key": "Capture",
  "label": "Capture",
  "sourcePatterns": [
    "apps/api/src/domain/items.ts",
    "apps/api/src/http/command-service.ts",
    "apps/api/src/db/repo.ts",
    "packages/shared/src/commands.ts",
    "packages/shared/src/domain/item.ts",
    "apps/web/src/components/CaptureForm.tsx"
  ]
}
```

...plus an optional `"parent": "<key>"` (§2c point 1) naming another entry,
which is the only thing that turns the flat list into a tree — nesting is a
registry decision, never something a `describe` name has to encode. No entry
uses it yet: nothing in the repo has grown a real sub-area in tests, so
there's nothing real to nest. The day `Dashboards` gets a `drag-drop` test,
the fix is one line here, not a rename anywhere in test code.

A describe's outer text resolves to an area by exact match on `key`
(`describe('Capture', ...)` → `Capture`). A source file resolves to **every**
area whose `sourcePatterns` it matches — as §2a covers, one file can back
several areas, and that is expected rather than an error. A file matching
zero entries falls into the implicit `infrastructure` bucket. What CI checks
(§7) is no longer file-side; see §2a for why and what replaced it.

**Seeded with** (`tools/test-explorer/concepts.json`, as built): `Capture` and
`Triage` have real source patterns (both have tests today, both reaching into
`items.ts`, `command-service.ts`, `db/repo.ts`, `commands.ts`, `item.ts`, and
their own frontend component); `Associations` and `Offline` likewise, plus
`Offline`'s own `packages/shared/src/ids.ts` (client-side ID generation for
offline capture, per [ids.test.ts](../packages/shared/tests/unit/ids.test.ts)).
`Sign-in` has real patterns too, added later with the sign-in recovery work.
`Dashboards`, `Panels`, `Focus`, `Connector management`, `User management` —
the rest of testing-strategy §9.1's example list — are declared with empty
`sourcePatterns: []` until code exists to match them; an empty pattern list
is legal and just means the row stays at zero everywhere until then.

A describe naming an area absent from the registry is a build error at
`--check-concepts` time (§7) — a typo'd or forgotten area name, not a silent
zero. A `parent` naming an absent or cyclical key is not a build error — it's
reported as a warning and that entry renders as a root instead, so a typo in
the registry degrades the tree shape rather than silently deleting rows
(§2c point 1).

## 6. Architecture

**Status: built.** §6.1–6.3 describe what actually exists at
`tools/test-explorer` (validated against a real fixture — see §9), not a plan.

### 6.1 Package: `tools/test-explorer`

Promoted from `poc/coverage-explorer`, inside the pnpm workspace (`tools/*`
added to `pnpm-workspace.yaml`). Not published, not deployed — a dev/CI tool.

Written as plain ESM JavaScript with JSDoc types, like the POC, rather than
compiled TypeScript: nothing else in this repo runs a standalone `.ts` file
directly (`apps/api` ships through `wrangler`, `apps/web` through `vite`,
both wired for a bundler; `packages/*` are `noEmit`, typechecked but never
executed as Node scripts). Introducing a TS-runner dependency (`tsx`,
`ts-node`) just for this one CLI would be new machinery for no benefit over
what the POC already proved works.

The POC's separation of concerns carries forward unchanged, because it is
sound independent of the model changes in §2:

```
tools/test-explorer/
├── src/
│   ├── model.js              the contract: Concept, Rule, the table shape (§4)
│   ├── analyze/
│   │   ├── ast.js               shared TS-compiler-API parsing + import resolution
│   │   ├── workspace.js         pnpm-workspace.yaml + package manifests (ported from the POC's nodes.js)
│   │   ├── concepts.js          loads concepts.json, matches files to area(s) (§5, §7)
│   │   ├── rules.js             walks tests/<level>/**, parses describe/it (§6.2)
│   │   ├── coverage.js          merges v8 coverage JSON if present, else reports "unknown" (§6.3)
│   │   └── index.js             repo path in, Model out
│   ├── render/
│   │   ├── html.js              table + expand panel, one self-contained file
│   │   ├── styles.css
│   │   └── client.js
│   └── cli.js
├── concepts.json
└── package.json
```

`policy/obligations.js` and `policy/annotations.js` from the POC are dropped
per §2 — there is no obligation inference left to override.

### 6.2 Rule extraction

Static AST parse of every file under each package's `tests/<level>/`
(TypeScript compiler API, matching the POC's approach): find every
`describe(...)` call, read its outer/inner nesting, and take the outermost
describe's text verbatim as the area key (no splitting — see §2a for why an
earlier draft of this section split on `.` and why that was wrong once the
real convention landed). Count one rule per second-level `describe` (or, if a
file has no nested describe, per top-level `describe`, so simple files aren't
forced into unnecessary nesting). `it`/`it.each`/`it.todo` bodies are read
too, so a rule with only `.todo` cases can be flagged distinctly if wanted
later, but §4 counts a rule once it has at least one real (non-todo) case.

Two dialects, one structure. Vitest writes `describe(...)`; Playwright, the
F3 runner, hangs it off the test object as `test.describe(...)` (with
`.serial`/`.parallel`/`.skip` modifiers). Both are recognized, because the
alternative was worse than not counting: `test.describe` matched no describe
form *and* matched the case form, so an F3 file would have reported its feature
areas as absent and each of its rule statements as a case label — a wrong
answer that looks like an answer. The same fix excludes Playwright's hooks and
configuration members (`test.beforeEach`, `test.use`, `test.step`, …), which
have no title at all and would otherwise have been counted as cases labelled
with the source text of their own callbacks.

This never runs the suite. A rule is counted from source, exactly like the
POC's actuals pass, so the report keeps working when the suite is red.

### 6.3 Coverage columns

"Files nothing runs" does not need coverage tooling — it's importer analysis,
already how the POC's `analyze/tests.js` works: read each test file's
imports, mark what it reaches.

"Branches nothing takes" does need real coverage. **Done** (§9 step 10): every
package's `vitest.config.ts` now has a `coverage: {...}` block, close to
[testing-decisions-wip.md](testing-decisions-wip.md)'s worked example but not
identical to it — that example's `all: true` doesn't exist on Vitest 4.1's
`CoverageOptions` type at all (a TypeScript build error, not a runtime no-op:
`tsc` rejects it, confirmed locally), because reporting every `include`-matched
file, touched by a test or not, is just the default behavior now rather than
an opt-in flag. Confirmed empirically that dropping the field changes
nothing: an untouched file (`packages/shared/src/api/events.ts`, imported by
no test) still appears in `coverage-final.json` with zero hits. The block
sits behind a new `test:coverage` script (`vitest run --coverage`) per
package, separate from the fast `test`/`test:unit` scripts so the
testing-strategy §7 time budget is unaffected — coverage is opt-in, not part
of the default run.

One provider split, found empirically rather than assumed: `packages/shared`
and `apps/web` use `provider: 'v8'`, but `apps/api` must use
`provider: 'istanbul'` instead. Trying `v8` against `apps/api` fails outright
(`ERR_METHOD_NOT_IMPLEMENTED`, `new StubSession`) — the Workers runtime
`@cloudflare/vitest-pool-workers` runs tests inside has no `node:inspector`
Session API for V8's native coverage to attach to, which is also Cloudflare's
own documented position (workers/testing/vitest-integration/known-issues,
"Code Coverage Support": *"Native code coverage via V8 is not supported. You
must use instrumented code coverage via Istanbul instead."*). Both providers
emit the same istanbul-shaped `coverage-final.json`, so `analyze/coverage.js`
(merged with `istanbul-lib-coverage`, already a dependency) needs no
provider-awareness of its own — it reads whatever's on disk uniformly.

`analyze/coverage.js` does the right thing whether or not `coverage/coverage-final.json`
exists under a package: absent, it reports `coverageAvailable: false` and
every concept's branches-nothing-takes column renders as **unknown**, never a
false zero. Verified end to end against the real repo (§9): `Triage` came
back with 4 real untaken branches in `apps/web/src/components/ItemRow.tsx`
(conditional JSX for sender/snooze/focus-horizon display that
`ItemRow.test.tsx` doesn't exercise) — the first real finding this column has
produced.

End-to-end coverage stays out of the merge at first, per the same source —
collecting v8 coverage from a real browser hitting a deployed Worker is
awkward and F3 is deliberately thin.

## 7. The concepts.json CI check

A separate, small check (not the explorer's render step, but shipped in the
same package since it validates the explorer's own input):
`tools/test-explorer/src/cli.js --check-concepts` runs the full analysis and
exits nonzero listing any feature area a test declares (its outer describe)
that isn't registered in `concepts.json`. This is **not** the file-pattern
check originally specced here — §2a covers why that check stopped being
coherent once one source file could legitimately back several areas, and why
anchoring to describe names instead is, if anything, the more direct guard:
it catches the actual mistake (a typo'd or forgotten area name) rather than a
downstream symptom of it. Runs as its own CI step (§8), and is the thing that
keeps the registry from silently going stale the way option 2.1's
hand-maintained tree would have.

## 8. CLI, scripts, CI

```bash
tools/test-explorer/package.json
  "generate":       "node src/cli.js"                    # writes out/index.html
  "model":          "node src/cli.js --json"              # writes out/model.json instead
  "check-concepts": "node src/cli.js --check-concepts"
```

("build" was deliberately avoided as a script name here — the root
`pnpm build` runs `pnpm -r build` across every package, and a `build` script
in this package would have made "generate the report" a silent side effect of
every ordinary build.)

Root `package.json` gets three new scripts:
`"test:explorer": "pnpm --filter @cockpit/test-explorer generate"`,
`"test:explorer:check": "pnpm --filter @cockpit/test-explorer check-concepts"`,
and `"test:coverage": "pnpm -r test:coverage"` (§6.3).

CI (`.github/workflows/ci.yml`): one new job, independent of `test`/`typecheck`/`build`
(it needs neither their success nor their output — see the note below):

```yaml
  test-explorer:
    name: Test Explorer
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - run: pnpm test:explorer:check   # fails the job on concepts.json drift
      - run: pnpm test:coverage         # instrumented — a second full run, see the note below
      - run: pnpm test:explorer
      - uses: actions/upload-artifact@v4
        with:
          name: test-explorer-report
          path: tools/test-explorer/out/
```

The original draft of this section had the job depend on `test` "needing the
per-level coverage output to exist" — that was wrong: GitHub Actions jobs run
in separate VMs, so a `needs:` dependency alone does not share a `coverage/`
directory another job wrote; only an uploaded/downloaded artifact would. Now
that coverage config exists (§6.3), the job runs the suite a second time,
instrumented (`pnpm test:coverage`), inside its own VM rather than trying to
reuse the plain `test` job's — a real cost (roughly doubling this job's
runtime; `apps/api`'s Workers-pool startup dominates either way, so
instrumentation itself is not the expensive part), accepted because it keeps
this job self-contained and avoids the artifact-hop complexity that sharing
across jobs would need.

**This publishes as a downloadable build artifact per run, not a gate.** No
job fails on a red cell in the report; the `check-concepts` step only fails on
`concepts.json` drift (an unmapped or double-mapped file), which is a
build-hygiene error, not a coverage judgment. Per
[coverage-reporting-options.md §Decision 4](coverage-reporting-options.md),
gating on the report's *content* is the last step of a suggested order
(generate → publish → live with it → gate) precisely because gating creates
the incentive to argue a node into a thinner obligation rather than test it.
Wiring the artifact into CI now (rather than leaving it on-demand) gets it in
front of you on every PR without taking that last, riskier step yet.

**Open question this spec does not resolve:** whether the artifact becomes a
persistently published page (GitHub Pages, or served from the Worker) instead
of a per-run download. An artifact is zero new infrastructure and sufficient
to start; a published page is nicer to browse and link but is a real decision
(new hosting, new deploy step) that deserves its own call once the report has
been lived with for a bit. Recommend: artifact now, revisit publishing once
the registry (§5) has stopped changing every week.

## 9. Build plan

All steps are **done**, twice over: first built and validated against the
in-progress alignment branch as a read-only fixture (before it merged), then
re-validated against the real merge (`0897f91`) once it landed, which is when
§2a's convention change surfaced and was fixed.

1. **Land the alignment branch.** Done — merged as
   [PR #51](https://github.com/michaelvanhoutte/cockpit/pull/51). Its actual
   describe convention differed from what was documented when this spec was
   first written; §2a is the record of that and what it changed.
2. **Seed `concepts.json`.** Done, twice: an entity-keyed seed
   (`item`/`command`) built against the pre-merge fixture, replaced after the
   merge with the real area-keyed seed (§5) — `Capture`, `Triage`,
   `Associations`, `Offline` with real source patterns confirmed against the
   merged test files' actual imports, plus the other five of
   testing-strategy §9.1's nine example areas with empty patterns.
3. **`model.js` and `analyze/rules.js`.** Done (§6.1, §6.2), updated for the
   undotted convention per §2a.
4. **`analyze/concepts.js`.** Done, including `--check-concepts`, redesigned
   per §2a/§7 around describe-name registration rather than file overlap.
5. **Per-package coverage config in `vitest.config.ts`, plus `analyze/coverage.js`'s merge step.**
   `analyze/coverage.js` is done and degrades correctly when coverage data is
   absent (§6.3). The config itself is done too, as of step 10 below.
6. **`render/html.js` and `render/client.js`.** Done — counts table + expand
   panel (§4.2, §4.3), no obligation-state matrix, updated copy for "feature
   area" per §2a.
7. **`cli.js`, package scripts, CI job.** Done (§8, corrected from the
   original draft's `needs: test` mistake — see §8's note).
8. **Run it against the real repo.** Done. Current output against `0897f91`:
   21 rules across the `Capture`/`Triage`/`Associations`/`Offline` areas that
   have tests, zero `unregisteredAreas`, `pnpm typecheck`/`test`/`build` all
   green.
9. **Tests for `tools/test-explorer` itself.** A code review of this package
   (§2b) found it had shipped with none — a real violation of
   [testing-strategy.md §5](testing-strategy.md)'s "new logic ships with L1
   tests in the same change," not a documented exemption the way `poc/` is.
   Fixed: `tools/test-explorer/tests/unit/` covers the glob matcher and
   multi-membership file resolution (`concepts.js`), rule extraction including
   the `describe.skip`/`.only` and empty-describe edge cases (`rules.js`), the
   branch-coverage merge (`coverage.js`), and one fixture-repo test exercising
   `analyze()` end to end (`index.js`), wired into `pnpm test`/`pnpm -r test`
   the same as every other package. Grew to 41 tests as of step 11.
10. **Wire up real branch coverage.** Done. `coverage: {...}` added to all
    three packages' `vitest.config.ts`, behind a new `test:coverage` script
    per package (§6.3) — opt-in, so it doesn't touch the fast-tier time
    budget. `apps/api` needed `provider: 'istanbul'` rather than `'v8'`,
    discovered by trying `'v8'` first and getting
    `ERR_METHOD_NOT_IMPLEMENTED` — the Workers runtime has no
    `node:inspector` Session API, confirmed as Cloudflare's own documented
    position. `.gitignore` gained a `coverage/` entry (the output dirs were
    showing up as untracked). CI's `test-explorer` job now runs
    `pnpm test:coverage` before generating the report. Running it for real:
    `Triage` came back with 4 genuine untaken branches in
    `apps/web/src/components/ItemRow.tsx` (conditional JSX for the
    sender/snooze/focus-horizon display, none of which `ItemRow.test.tsx`
    currently exercises) — the column's first real finding.

**One honest limitation surfaced by the real run, not "fixed" because it
can't be**: `apps/api/tests/integration/http/item-changes.test.ts` drives the
Worker over real HTTP rather than importing `command-service.ts`/`db/repo.ts`
directly, so "files nothing runs" reports false positives on exactly those
two files. §2a covers this in full; the mitigation is a warning naming the
limitation, not a heuristic that guesses which files an HTTP call reached.
11. **First-use feedback: tree rows, real levels, hyperlinks, GitHub commit
    link, readable gaps.** Done — §2c is the full record. `model.js`'s
    `TreeNode`/`LEVELS` replaced the flat `ConceptRow`/`Column` shape;
    `concepts.js` gained `buildTree` (5 new tests, including the cycle case);
    `rules.js`'s `levelForTestFile` replaced `columnAndLevelForTestFile`;
    `render/client.js` and `styles.css` got the tree UI, bigger rule cards,
    file links and the on-page legend; `analyze/index.js` gained
    `commitUrl`, `availableLevels`, and per-branch source snippets. 10 new
    tests, 41 total.
12. **Second-look feedback: tabbed panel, case-level detail, inline source
    viewer.** Done — §2d is the full record. `concepts.json` gained a real
    (placeholder) `Dashboards` → `Drag-drop`/`Resizing` nesting so the tree
    has something to show; the panel became three tabs instead of stacked
    sections, on a genuinely wide, sticky layout, after fixing a real
    shared-card layout bug; `Rule.cases`/`todoCases` became `CaseRef[]`
    (text + location) instead of plain counts, which surfaced and fixed a
    real `it.each(table)(name, fn)` chained-call parsing bug; every
    file:line in the model (rule, case, branch gap, whole-file gap) now
    carries a `context` window of real source, toggled inline in the
    browser with GitHub-blob and local-file links — which also caught a
    real bug, `commitUrl` never having been included in the page's embedded
    model payload. 2 new tests, 43 total.

## 10. Explicitly out of scope for this spec

Recorded so they aren't silently expected and aren't silently re-litigated:

- **Gating CI on report content.** §8.
- **A persistently published/hosted page.** §8.
- **The `describe.todo`/`it.todo` merge-guard** (a statement approved but not
  yet built must survive as a visible todo, and a PR can't merge with one
  left). Related — todos live in the same test files this tool reads — but it
  is its own lint/CI rule, not a rendering concern of the explorer, per
  [testing-decisions-wip.md §"Seeing what isn't tested"](testing-decisions-wip.md).
  Worth building next; not blocking this.
- **Mutation testing.** Explicitly postponed in the settled design.
- **The Android-versus-web split of the frontend levels**, flagged as an open
  gap in [ideas.md §9](ideas.md). `apps/web` is one row-source today; splitting
  Frontend into a Web/Android pair is a column change deferred until an
  Android target exists.

## 11. Housekeeping once this lands

- [coverage-reporting-options.md](coverage-reporting-options.md) decisions 1.4
  and 2.3 get a short amendment note pointing here, rather than being rewritten
  — it stays the record of the options considered.
- [testing-decisions-wip.md](testing-decisions-wip.md)'s "Still open" item
  "The coverage options document needs amending" is resolved by this
  document.
- `poc/coverage-explorer` gets a one-line pointer added to its README noting
  it was promoted to `tools/test-explorer` per this spec, rather than being
  deleted outright — it stays as the showcased proof-of-concept trail per
  architecture §3's stated reason for keeping `poc/`.
