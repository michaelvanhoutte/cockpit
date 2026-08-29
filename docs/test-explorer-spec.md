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

### 4.1 Rows: feature areas

A checked-in **area registry** (§5) lists every feature area: a key (equal
to its display label — see §2a, there is no dotted entity name to display
separately anymore), and the source-file glob patterns it owns. `Capture`,
`Triage`, `Offline`, `Associations`, `Dashboards`, `Panels`, `Focus`,
`Connector management`, `User management` are the nine areas seeded from
[testing-strategy.md §9.1](testing-strategy.md)'s own example list — nothing
restricts the registry to exactly those nine; it grows as new areas appear in
tests. Backend plumbing that no area owns (the event stream, tenancy, app
wiring — code testing-decisions-wip says stays whole rather than splitting by
feature) lives under an implicit `infrastructure` bucket, not left unmatched.
Rows are one feature area each, plus one `Infrastructure` row for everything
matching no area's patterns.

### 4.2 Columns

| Column | Source | Meaning |
|---|---|---|
| Backend | test files under `apps/api/tests/{unit,integration}/` and `packages/*/tests/unit/`, count of rules (inner `describe`s) whose outer describe text matches this area's key | count, not a state |
| Frontend | same, under `apps/web/tests/{unit,service}/` | count |
| Browser | same, under `tests/e2e/` (F3) | count |
| Contract | same, under `packages/connectors/*/tests/contract/`, `n/a` for any area that owns no connector | count or `n/a` |
| Files nothing runs | source files matching this area's patterns that no test file (at any level) imports directly — a real limitation for HTTP-driven integration tests; see §2a | count, list on expand |
| Branches nothing takes | merged branch coverage (§6.3) restricted to this area's files | count, locations on expand |

No percentage anywhere, including as a secondary number, per the settled
design's explicit reasoning: once one exists it becomes the thing people look
at, and it is the one number here that can rise without proving anything.

### 4.3 Expand-on-click

Selecting a row shows:

- every rule counted in that row's Backend/Frontend/Browser/Contract cells,
  as its inner-describe statement, with which column/level it sits at and its
  file:line;
- the file and line location of every branch nothing takes, restricted to
  this area's files;
- the path of every file nothing runs, restricted to this area's files.

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
`Dashboards`, `Panels`, `Focus`, `Connector management`, `User management` —
the rest of testing-strategy §9.1's example list — are declared with empty
`sourcePatterns: []` until code exists to match them; an empty pattern list
is legal and just means the row stays at zero everywhere until then.

A describe naming an area absent from the registry is a build error at
`--check-concepts` time (§7) — a typo'd or forgotten area name, not a silent
zero.

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

This never runs the suite. A rule is counted from source, exactly like the
POC's actuals pass, so the report keeps working when the suite is red.

### 6.3 Coverage columns

"Files nothing runs" does not need coverage tooling — it's importer analysis,
already how the POC's `analyze/tests.js` works: read each test file's
imports, mark what it reaches.

"Branches nothing takes" does need real coverage. Each level's Vitest config
needs `coverage: { provider: 'v8', all: true, reporter: ['json'] }` (per
[testing-decisions-wip.md](testing-decisions-wip.md)'s worked example) — not
added yet anywhere, since it belongs in the same per-package `vitest.config.ts`
files the alignment branch (§3) is introducing, and this spec does not modify
that branch. `analyze/coverage.js` is written and does the right thing the
moment `coverage/coverage-final.json` exists under a package (merged with
`istanbul-lib-coverage`, already a dependency): until then it reports
`coverageAvailable: false` and every concept's branches-nothing-takes column
renders as **unknown**, never a false zero — verified against the real merged
repo in §9. Adding the coverage config to `apps/api` and `apps/web`'s Vitest
configs is listed as follow-up work in §9.

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

Root `package.json` gets two new scripts:
`"test:explorer": "pnpm --filter @cockpit/test-explorer generate"` and
`"test:explorer:check": "pnpm --filter @cockpit/test-explorer check-concepts"`.

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
      - run: pnpm test:explorer
      - uses: actions/upload-artifact@v4
        with:
          name: test-explorer-report
          path: tools/test-explorer/out/
```

The original draft of this section had the job depend on `test` "needing the
per-level coverage output to exist" — that was wrong: GitHub Actions jobs run
in separate VMs, so a `needs:` dependency alone does not share a `coverage/`
directory another job wrote; only an uploaded/downloaded artifact would, and
nothing here does that. Since no coverage config exists yet either (§6.3),
the job simply runs standalone and reports `coverageAvailable: false` for
now, correctly.

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
5. **Per-level v8 coverage config in `vitest.config.ts`, plus `analyze/coverage.js`'s merge step.**
   `analyze/coverage.js` is done and degrades correctly (§6.3), confirmed
   against the real merged repo: `apps/api`/`apps/web`/`packages/shared` all
   now have `vitest.config.ts`, but none configure `coverage: {...}` yet, so
   every run today correctly reports `coverageAvailable: false`. **Adding
   that config remains the one concrete follow-up this spec doesn't do**,
   since it means editing those packages' own Vitest configs, which belongs
   with whoever owns the testing-strategy work next rather than being folded
   into this tool's build silently.
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
   `analyze()` end to end (`index.js`) — 31 tests total, wired into
   `pnpm test`/`pnpm -r test` the same as every other package.

**One honest limitation surfaced by the real run, not "fixed" because it
can't be**: `apps/api/tests/integration/http/item-changes.test.ts` drives the
Worker over real HTTP rather than importing `command-service.ts`/`db/repo.ts`
directly, so "files nothing runs" reports false positives on exactly those
two files. §2a covers this in full; the mitigation is a warning naming the
limitation, not a heuristic that guesses which files an HTTP call reached.

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
