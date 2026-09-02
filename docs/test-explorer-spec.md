# Test Explorer: Build Spec

**Status:** built at `tools/test-explorer`, validated against the real, merged test
suite (commit `0897f91`, [PR #51](https://github.com/michaelvanhoutte/cockpit/pull/51)).
Settles the open questions from [testing-decisions-wip.md](testing-decisions-wip.md)
that blocked implementation, and is authoritative where it disagrees with
[coverage-reporting-options.md](coverage-reporting-options.md) or the prototype in
[poc/coverage-explorer](../poc/coverage-explorer/README.md). Those two stay as the
record of *why*; this is *what got built*.

## 1. What this tool answers

Without reading the code: which parts of the product own which tests, and which parts
are thin. The shape that answers it is a table, not a drill-down pyramid and not a
treemap:

> Rows are parts of the product. Columns are counts, not states.

## 2. What changed since the options document, and why the POC is not the base

The options document's preferred design (implemented in the POC) does three things this
spec drops:

1. **A state per cell** (met / partial / required-and-absent / n/a) for every node
   crossed with every level. A rule lives at exactly one level — the lowest able to
   prove it — so "Actions owes an integration test and a unit test" is not a real
   obligation and there is nothing to mark absent. The table holds **counts** instead,
   plus two coverage columns that *are* real zero/nonzero facts.
2. **Obligation inferred from three structural signals** (branch count, purity,
   fan-in). No longer needed, because the table shows what exists rather than what is
   owed; `poc/coverage-explorer/src/policy/obligations.js` is not carried forward. What
   survives is plain branch and statement coverage, which is measurement rather than
   inference.
3. **Nodes from four structural sources** with the product concept only a secondary
   axis. Inverted: the product concept is the **primary** row axis, from a checked-in
   registry (§5). This is the amendment testing-decisions-wip flagged as owed.

What the POC gets right and this keeps: the `model.js` contract separating derivation
from rendering, deriving from artifacts the repo already maintains rather than a
hand-authored tree, and reading test files rather than running them so the report does
not depend on the suite being green.

## 2a. A convention change that landed mid-build, and what it broke

§4–§5 were written against a dotted `concept.subaction` describe convention. By the
time the test-alignment branch merged, that had been replaced: testing-strategy's
"Tests are named in the product's language" is explicit that the outer `describe` is an
**undotted feature area**, because `item.setStatus` and `command.idempotency` name an
object or a function rather than a part of the product.

**The mechanical fix** (§6.2): the area is the outer describe's text verbatim, no
`.`-splitting.

**The structural consequence is bigger than a rename.** A dotted entity gave every rule
a near-exclusive owner; a feature area does not. `apps/api/src/domain/items.ts` holds
`captureItem` (backs `Capture`) and `applySetStatus`/`applySnoozeUntil` (back `Triage`
and `Offline`'s stale-write rejection) in one file. §5's original invariant — "every
source file matches exactly one concept, checked in CI" — is not coherent once one file
legitimately backs several areas. Two changes:

1. **Multi-membership is allowed and expected.** `sourcePatterns` routinely overlap
   across areas; a file matching zero areas still falls into the implicit
   `infrastructure` bucket. Only the "at most one" half of the invariant is gone.
2. **`--check-concepts` changed what it gates on.** It now fails the build when a test
   declares a feature area absent from `concepts.json` — the same kind of guarantee,
   anchored to describe names rather than file patterns, and arguably the more direct
   check: it catches `describe('Trige', ...)` rather than a downstream symptom.

**A second finding from running against the real suite.**
`apps/api/tests/integration/http/item-changes.test.ts` drives the real Worker over HTTP
(`SELF.fetch`) rather than importing `accounts/command-service.ts` or `accounts/repo.ts`,
which is exactly the mandated "enter through the real interface" pattern. "Files nothing
runs" (§6.3) is import-reach only, so it cannot see that and reports both files as
untested — false positives on precisely the file the original coverage audit called the
highest-value gap. Rather than a heuristic that risks new false negatives,
`analyze/index.js` detects any test importing `SELF` from `cloudflare:test` and emits
one warning naming the limitation.

## 2b. How the built tool got its current shape

Six rounds of real use and two automated code reviews. The durable outcomes, each with
the reason:

**Rows and columns**

- **Rows are a tree**, because a big area will grow real sub-areas. An entry may carry
  `"parent": "<key>"` (§5) and `buildTree` turns the flat registry into a tree, with
  cycle detection so a looping parent chain becomes roots with a warning rather than
  silently vanishing. Nothing nests today: a demonstration nesting was added to prove
  the UI renders and then removed, because an invented row in a registry whose whole
  point is deriving structure from what exists cuts against the tool.
- **Per-node applicability is not guessed.** Rendering "leaves never get F3" as n/a
  would be a return to the state-inference model §2 dropped. Real counts ship, honestly
  zero, with the tree supplying the context.
- **Seven columns, not three.** The table was collapsing L1+L2 and F1+F2 and dropping
  L3 entirely. `levelForTestFile` now maps a test file to one of L1/L2/L3/F1/F2/F3/
  Contract. **L3 is n/a everywhere today**, not zero, derived from real workspace data
  (more than one package with a `wrangler` config) rather than hardcoded — the same
  pattern Contract already used.
- **A node's counts are its own only**; a parent does not sum its children. The tree
  structure shows the relationship.

**Reading a row**

- **The panel is three tabs** (Rules / Files nothing runs / Branches nothing takes), not
  sections stacked in one scroll, so any one is one click away. Fixing this caught a
  real layout bug: both sides shared one `.card`, so its background stretched to the
  taller one.
- **The panel is a fixed overlay** pinned to the viewport's right edge, full height,
  with `body` reserving its width. It was `position: sticky` inside the document flow,
  so on load it only had whatever space was left below the masthead — its size was never
  the problem, its position was. Below 1000px it falls back to a stacked block.
- **Rules carry their cases, not just a count** — each `it(...)`'s own text and
  location, printed the way the runner would. Building this surfaced a real parsing bug:
  `it.each(table)(name, fn)` is two chained calls, and the naive match read the entire
  data table as one case's name. (The tagged-template form is still unrecognized; it is
  unused here.)
- **A `.each` template resolves to what was actually tested.** `rules.js` statically
  evaluates a literal table and substitutes each row into `$key`/`$a.b` and `%s`/`%d`/
  `%j`/`%o`/`%#` placeholders. Resolution is per-property, not all-or-nothing, because a
  real case has a sibling property built from `uuidv7()` — a call, not a literal — which
  must not stop `situation` from resolving. Anything unresolvable is left as written.
- **No green ✓ next to a case.** This tool never runs the suite, so a checkmark claimed
  a fact it cannot know. Only "not written yet" (a `.todo`) gets a badge, because that
  is a fact the AST does know.
- **Rules group under a per-level heading** in the fixed `LEVELS` order, replacing a
  small per-card badge — one place to see the level, not two. A genuine table
  (row per case) was rejected: a statement is prose that does not compress into a cell,
  and the real relationship is one rule to many cases.
- **The statement leads the card**, with `file:line` following at reduced weight. The
  location is metadata; the statement is the point.
- **Every count cell is independently clickable.** A level's count selects the concept,
  opens Rules and filters to that level behind a dismissible chip; the concept's name
  shows every level; a gap count jumps to its tab.
- **Every `file:line` toggles an inline, line-numbered source window** read at analyze
  time and cached per file, with "Open on GitHub" (a `#L<line>` anchor from `commitUrl`,
  derived from the `origin` remote, null when it is not GitHub) and a local relative
  link as fallback. The relative prefix is computed in `cli.js`, not stored in the
  Model, since "where will this be opened from" is a render concern.
- **A persistent legend on the page** explains both coverage columns and all seven level
  columns in one sentence each. A hover tooltip does not answer "I don't understand this
  column".

**Acting on a gap**

- **Rejected: an LLM-suggested "missing tests" column**, and rejected again as a
  per-gap LLM call from the report. Every number on this page is a measured fact about
  the repository; an opinion about what is missing is neither measured nor reproducible,
  and mixing invented content into a page whose value is "you can trust every cell"
  undermines the real cells. A dismissed suggestion also has nowhere to go and would
  reappear every regeneration. The `scoping` skill already owns that job.
- **One "copy prompt" per concept, not per gap.** The per-gap button was built and then
  rejected in use: its embedded snippet was, for almost any file, just the import lines
  — nowhere near enough to judge whether a test is warranted. Showing the real file
  instead was also rejected, because the judgment call then repeats once per gap.
  `allGapsPrompt(node)` lists every file and branch gap as plain paths with one closing
  instruction to use this repo's test strategy to decide which need a test.
  `copyToClipboard()` falls back to a visible auto-selected `<textarea>` when clipboard
  access is unavailable — never a silent failure.
- **Deliberately not attempted: tying a gap to the rule it is "missing from".** The
  analyzer has no per-rule import tracing, so any such link would be a guess dressed up
  as a fact.

**Correctness fixes worth carrying, because each was a wrong answer that looked right**

- `--check-concepts` fed only rules, so a typo'd area with no cases yet — the exact
  scaffolding moment it exists to catch — passed silently. It now sees every describe
  name.
- `describe.skip`/`.only` at the top level silently dropped the whole area, inconsistent
  with `it.skip` already counting.
- `markReached` missed per-specifier `type` imports, so a file TypeScript elides could
  be marked reached.
- `branchesNotTaken` only caught branches where *every* path was untaken, missing an
  `if` with no `else` tested on the taken side.
- `summarise()` double-counted files shared between areas: the masthead read 29 files
  against a true 21. Deduplicated by path, and by `file:line` for branches.
- `branchesNotTaken` returned `[]` for a file with no coverage data at all,
  indistinguishable from a measured zero. It returns `null` now and the run collects one
  named warning — the same "a missing measurement must never look like a clean one"
  invariant the workspace-wide `coverageAvailable` flag already had.
- Fixing that exposed a fourth bug it had been hiding: the coverage map was keyed by
  `path.join`'s platform separator, which the v8 provider matches on Windows and
  istanbul does not, so `apps/api`'s entire branches column was silently wrong there
  from the moment coverage landed. Fixed by matching on a separator-normalized key,
  memoized per map; the warning list dropped from fifteen false positives to the six
  genuinely unmeasured files.
- `levelForTestFile`'s regex allowed one path segment between `packages/` and `/tests/`,
  so `packages/connectors/gmail/tests/unit/` would have been skipped — latent today, and
  it would have made `--check-concepts` blind inside that file the moment a connector
  landed.
- `parseArgs` called `process.exit` directly, which would kill the test runner, and
  `cli.js` called `main()` at import time with no entry-point guard, so importing it to
  test would run the real CLI against the runner's `process.argv`. Both fixed; the guard
  uses `pathToFileURL(process.argv[1]).href` rather than a `file://` template string,
  which mishandles Windows drive letters.
- `cli.js`'s unnecessary shebang broke vite-node's transform (`SyntaxError: Invalid or
  unexpected token`) the moment a test imported it as a non-entry module. Removed; every
  caller invokes it as `node src/cli.js`.
- Three stubs and duplications: `hasConnector()` was hardcoded and ignored the workspace
  data `analyze()` already computes; the Infrastructure label was computed twice and
  leaked a stray sub-label; the HTTP-reach warning named its original example files
  rather than whichever tests actually triggered it.
- Each test file was parsed into a fresh AST three times per run, tripling the tool's
  dominant cost. Parsed once and shared.
- The package shipped with **zero tests**, a real violation of "new logic ships with L1
  tests in the same change", which is why §9 step 9 exists. A later review moved
  `index.test.js` to `tests/integration/` — it builds a real file tree, so the fix was
  to admit it is an L2 test, not to fake the filesystem — and added unit tests for
  `parseArgs` and for `render/html.js`'s `esc`/`jsonScript`, which are pure and directly
  security-relevant.

## 2c. Where a row comes from, vs. where its counts come from

Easy to conflate, so stated precisely:

- **Which rows exist is registry-driven**, not test-driven. Every entry in
  `concepts.json` becomes a row, `parent` and all, whether or not any test names it —
  areas are declared ahead of the code and stay at zero until real tests land.
- **What populates a row is test-derived, without exception.** Every count, rule, case
  and coverage gap comes from real `describe`/`it` blocks, real import graphs and real
  coverage data.

`tools/test-explorer/README.md` exists to make this distinction explicit for anyone
reading the registry cold.

## 3. The test-folder migration (done)

The model in §4 depends on two conventions, both true of `main` as of `0897f91`: tests
physically separated into `tests/unit/`, `tests/integration/` and so on per package, so
a test's level is read from its folder rather than inferred; and the outer `describe`
naming a feature area, so a rule's area is read from that text directly.

## 4. Data model

### 4.1 Rows: a tree of feature areas

A checked-in **area registry** (§5) lists every feature area: a key equal to its display
label, the source-file glob patterns it owns, and an optional `parent` nesting it under
another entry. `Capture`, `Triage`, `Offline`, `Associations`, `Dashboards`, `Panels`,
`Focus`, `Connector management` and `User management` are the nine root areas seeded
from testing-strategy's example list; `Sign-in`, `Workspace management` and `Accounts`
were added since, each on the day the product grew a behaviour the earlier areas had no
word for. Nothing restricts the registry to those, or to being flat. Backend plumbing no
area owns lives under an implicit `infrastructure` bucket, always a root and always last.

### 4.2 Columns

The seven columns are `model.js`'s `LEVELS`, in testing-strategy's own order:

| Column | Source | Meaning |
|---|---|---|
| L1 | `apps/api/tests/unit/`, `packages/*/tests/unit/` (excluding connectors) | count of rules whose outer describe matches this area's key |
| L2 | `apps/api/tests/integration/`, `packages/*/tests/integration/` | count |
| L3 | `apps/*/tests/system/` (no folder exists yet) | count, or `n/a` for every row while the workspace has one backend service |
| F1 | `apps/web/tests/unit/` | count |
| F2 | `apps/web/tests/service/` | count |
| F3 | `tests/e2e/` at the repo root | count (Playwright spells the same structure `test.describe`; see §6.2) |
| Contract | `packages/connectors/*/tests/contract/` | count, or `n/a` for any area with no connector package |
| Files nothing runs | — | source files matching this area's patterns that no test file imports directly — a real limitation for HTTP-driven integration tests, see §2a |
| Branches nothing takes | — | merged branch coverage (§6.3) restricted to this area's files |

No percentage anywhere, including as a secondary number: once one exists it becomes the
thing people look at, and it is the one number here that can rise without proving
anything.

### 4.3 Selecting a row: three tabs

- **Rules**: every rule counted in that row's own cells, as its inner-describe
  statement, with its level and each of its cases and todo cases with their own text.
- **Files nothing runs**: every source file matching this area's own patterns that no
  test imports, restricted to this node rather than its children.
- **Branches nothing takes**: every branch gap in this area's own files.

No "reason for the level" is computed. The level is read mechanically from the folder,
and *why* a rule sits there is a call the author made when placing the file; capturing
that reason is a testing-strategy concern, not something the explorer blocks on.

## 5. The area registry

One checked-in file, `tools/test-explorer/concepts.json` (filename kept for continuity;
the content is areas, not dotted concepts):

```json
{
  "key": "Capture",
  "label": "Capture",
  "sourcePatterns": [
    "apps/api/src/domain/items.ts",
    "apps/api/src/accounts/command-service.ts",
    "apps/api/src/accounts/repo.ts",
    "packages/shared/src/commands.ts",
    "packages/shared/src/domain/item.ts",
    "apps/web/src/components/CaptureForm.tsx"
  ]
}
```

...plus an optional `"parent": "<key>"`, which is the only thing that turns the flat list
into a tree — nesting is a registry decision, never something a `describe` name has to
encode. No entry uses it yet, because nothing has grown a real sub-area in tests; the day
`Dashboards` gets a drag-drop test, the fix is one line here rather than a rename in
test code.

A describe's outer text resolves to an area by exact match on `key`. A source file
resolves to **every** area whose patterns it matches, which is expected rather than an
error (§2a); a file matching none falls into `infrastructure`.

**Seeded with:** `Capture`, `Triage`, `Associations` and `Offline` have real source
patterns (`Offline` also owning `packages/shared/src/ids.ts` for client-side ID
generation), as do `Sign-in`, `Workspace management` and `Accounts`, each added with the
work that created them. `Dashboards`, `Panels`, `Focus`, `Connector management` and
`User management` are declared with empty `sourcePatterns` until code exists to match
them, which is legal and just holds the row at zero.

A describe naming an unregistered area is a build error at `--check-concepts` time. A
`parent` naming an absent or cyclical key is a warning and renders as a root instead, so
a registry typo degrades the tree shape rather than silently deleting rows.

## 6. Architecture

**Status: built.** This describes what exists at `tools/test-explorer`, not a plan.

### 6.1 Package: `tools/test-explorer`

Promoted from `poc/coverage-explorer`, inside the pnpm workspace. Not published, not
deployed — a dev and CI tool.

Plain ESM JavaScript with JSDoc types rather than compiled TypeScript, because nothing
else here runs a standalone `.ts` file directly (`apps/api` ships through `wrangler`,
`apps/web` through `vite`, `packages/*` are `noEmit`), and adding a TS runner for one
CLI would be new machinery for no benefit.

```
tools/test-explorer/
├── src/
│   ├── model.js              the contract: Concept, Rule, the table shape (§4)
│   ├── analyze/
│   │   ├── ast.js               shared TS-compiler-API parsing + import resolution
│   │   ├── workspace.js         pnpm-workspace.yaml + package manifests
│   │   ├── concepts.js          loads concepts.json, matches files to area(s) (§5, §7)
│   │   ├── rules.js             walks tests/<level>/**, parses describe/it (§6.2)
│   │   ├── coverage.js          merges coverage JSON if present, else reports "unknown"
│   │   └── index.js             repo path in, Model out
│   ├── render/
│   │   ├── html.js              table + expand panel, one self-contained file
│   │   ├── styles.css
│   │   └── client.js
│   └── cli.js
├── concepts.json
└── package.json
```

`policy/obligations.js` and `policy/annotations.js` are dropped per §2 — there is no
obligation inference left to override.

### 6.2 Rule extraction

Static AST parse of every file under each package's `tests/<level>/`: find every
`describe(...)`, read the nesting, and take the outermost describe's text verbatim as
the area key. Count one rule per second-level `describe`, or per top-level one where a
file has no nesting, so simple files are not forced into it. `it`/`it.each`/`it.todo`
bodies are read too, and a rule counts once it has at least one non-todo case.

**Two dialects, one structure.** Vitest writes `describe(...)`; Playwright hangs it off
the test object as `test.describe(...)` with `.serial`/`.parallel`/`.skip` modifiers.
Both are recognized, because the alternative was worse than not counting: `test.describe`
matched no describe form *and* matched the case form, so an F3 file reported its areas as
absent and each statement as a case label — a wrong answer that looks like an answer. The
same fix excludes Playwright's hooks and configuration members (`test.beforeEach`,
`test.use`, `test.step`), which have no title and would be counted as cases labelled with
their own callback source.

**This never runs the suite**, so the report keeps working when the suite is red.

### 6.3 Coverage columns

"Files nothing runs" needs no coverage tooling — it is importer analysis: read each test
file's imports, mark what it reaches.

"Branches nothing takes" needs real coverage, and it is wired up. Every package's
`vitest.config.ts` has a `coverage` block behind a `test:coverage` script
(`vitest run --coverage`), separate from the fast scripts so the time budget is
unaffected. It is close to testing-decisions-wip's worked example but not identical:
that example's `all: true` does not exist on Vitest 4.1's `CoverageOptions` at all
(a `tsc` error, confirmed locally), because reporting every `include`-matched file is
now the default rather than an opt-in — verified empirically, an untouched file still
appears in `coverage-final.json` with zero hits.

**One provider split, found empirically.** `packages/shared` and `apps/web` use
`provider: 'v8'`; `apps/api` must use `'istanbul'`. Trying `v8` fails outright
(`ERR_METHOD_NOT_IMPLEMENTED`, `new StubSession`), because the Workers runtime has no
`node:inspector` Session API — which is Cloudflare's own documented position. Both
providers emit the same istanbul-shaped `coverage-final.json`, so `analyze/coverage.js`
needs no provider-awareness.

`analyze/coverage.js` reports `coverageAvailable: false` when no `coverage-final.json`
exists and renders the column as **unknown**, never a false zero. Verified end to end:
`Triage` came back with 4 real untaken branches in `apps/web/src/components/ItemRow.tsx`
— conditional JSX for sender, snooze and focus-horizon display that `ItemRow.test.tsx`
does not exercise — the column's first real finding.

End-to-end coverage stays out of the merge: collecting v8 coverage from a real browser
hitting a Worker is awkward and F3 is deliberately thin.

## 7. The concepts.json CI check

`tools/test-explorer/src/cli.js --check-concepts` runs the full analysis and exits
nonzero listing any feature area a test declares that is not registered. This is **not**
the file-pattern check originally specced — §2a covers why that stopped being coherent
— and it is the more direct guard, catching the actual mistake rather than a symptom.
It is what keeps the registry from silently going stale.

## 8. CLI, scripts, CI

```bash
tools/test-explorer/package.json
  "generate":       "node src/cli.js"                    # writes out/index.html
  "model":          "node src/cli.js --json"              # writes out/model.json instead
  "check-concepts": "node src/cli.js --check-concepts"
```

`build` was deliberately avoided as a script name: the root `pnpm build` runs
`pnpm -r build`, which would have made generating the report a silent side effect of
every ordinary build. The root gains `test:explorer`, `test:explorer:check` and
`test:coverage` (`pnpm -r test:coverage`).

CI (`.github/workflows/ci.yml`) gains one job, independent of `test`, `typecheck`
and `build` — it needs neither their success nor their output:

```yaml
  test-explorer:
    name: Test Explorer
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - run: pnpm test:explorer:check   # fails the job on concepts.json drift
      - run: pnpm test:coverage         # instrumented — a second full run, see below
      - run: pnpm test:explorer
      - uses: actions/upload-artifact@v4
        with:
          name: test-explorer-report
          path: tools/test-explorer/out/
```

The original draft had the job `needs: test` "to reuse the coverage output", which was
wrong: Actions jobs run in separate VMs, so only an uploaded artifact shares a directory.
The job runs the suite a second time, instrumented, inside its own VM — roughly doubling
its runtime, accepted because it keeps the job self-contained and avoids the artifact hop.

**This publishes as a downloadable artifact per run, not a gate.** No job fails on a red
cell; `check-concepts` only fails on registry drift, which is build hygiene rather than a
coverage judgment. Gating on content is the last step of the suggested order (generate →
publish → live with it → gate) precisely because gating creates the incentive to argue a
node into a thinner obligation rather than test it.

**Open question:** whether the artifact becomes a persistently published page (Pages, or
served from the Worker). An artifact is zero new infrastructure; a published page is a
real decision with new hosting and a deploy step. Recommend artifact now, revisit once
the registry has stopped changing weekly.

## 9. Build plan

All steps **done**, twice over: first against the in-progress alignment branch as a
read-only fixture, then re-validated against the real merge (`0897f91`), which is when
§2a's convention change surfaced.

1. Land the alignment branch (PR 51).
2. Seed `concepts.json` — replaced after the merge with the area-keyed seed of §5.
3. `model.js` and `analyze/rules.js`, updated for the undotted convention.
4. `analyze/concepts.js`, including `--check-concepts` redesigned around describe names.
5. Per-package coverage config plus `analyze/coverage.js`'s merge step.
6. `render/html.js` and `render/client.js` — counts table plus panel, no obligation matrix.
7. `cli.js`, package scripts, CI job.
8. Run against the real repo: 21 rules across the four areas that have tests, zero
   unregistered areas, `pnpm typecheck`/`test`/`build` green.
9. Tests for the package itself, which had shipped with none. `tests/unit/` covers the
   glob matcher and multi-membership resolution, rule extraction including the
   `describe.skip`/`.only` and empty-describe cases, the branch-coverage merge, and one
   fixture-repo test exercising `analyze()` end to end. 43 tests as of step 12.
10. Wire up real branch coverage (§6.3), including `apps/api`'s istanbul provider and a
    `coverage/` entry in `.gitignore`.
11. First-use feedback: tree rows, real levels, hyperlinks, commit link, readable gaps.
12. Second-look feedback: tabbed panel, case-level detail, inline source viewer.

Rounds 11–12 and the later feedback and review rounds are summarised in §2b.

## 10. Explicitly out of scope

- **Gating CI on report content** (§8).
- **A persistently published page** (§8).
- **The `describe.todo`/`it.todo` merge-guard.** Related, since todos live in the files
  this tool reads, but it is its own lint or CI rule rather than a rendering concern.
  Worth building next; not blocking this.
- **Mutation testing**, explicitly postponed in the settled design.
- **The Android-versus-web split of the frontend levels**, flagged as an open gap in
  ideas.md. Deferred until an Android target exists.

## 11. Housekeeping once this lands

- [coverage-reporting-options.md](coverage-reporting-options.md) decisions 1.4 and 2.3
  get a short amendment note pointing here, rather than being rewritten.
- testing-decisions-wip's "The coverage options document needs amending" is resolved by
  this document.
- `poc/coverage-explorer` gets a one-line pointer noting it was promoted to
  `tools/test-explorer`, rather than being deleted — it stays as the proof-of-concept
  trail.
