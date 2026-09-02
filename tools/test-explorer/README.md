# Test Explorer

Answers, without reading the code: which parts of the product own which tests, at which
testing-strategy level, and which files or branches nothing exercises. Generates one
self-contained HTML page from the repository as it exists right now.

The design rationale — what was tried and rejected, and why it is shaped this way —
lives in [docs/test-explorer-spec.md](../../docs/test-explorer-spec.md). This is the
practical "how do I run it and what does it read" version.

## Running it

```bash
pnpm test:explorer          # from the repo root — writes out/index.html
pnpm test:explorer:check    # fails if a test names a feature area not in concepts.json
```

Or directly from this package:

```bash
cd tools/test-explorer
node src/cli.js                    # writes out/index.html
node src/cli.js --json             # writes out/model.json instead, for another consumer
node src/cli.js --check-concepts   # the CI check, see below
node src/cli.js --repo <path>      # analyze a different checkout
node src/cli.js --help
```

`out/index.html` is a complete file — open it directly, no server needed. It is
gitignored. For the "branches nothing takes" column to show real data instead of
`unknown`, run `pnpm test:coverage` first.

## Where the rows come from — and where the counts come from

Two different questions, easy to conflate:

**Which rows exist** comes entirely from [`concepts.json`](./concepts.json), the
checked-in area registry, not from test files. An entry can be declared with empty
`sourcePatterns` *ahead of* any code that will back it (`Focus`, `Connector management`
and `User management` are exactly this today), and can carry `"parent": "<key>"` to nest
under another entry — which is what makes the rows read as the product's own containment,
a Workspace holding an Inbox and Dashboards, a Dashboard holding Panels. Both are
registry decisions, unconnected to whether any test exists.

**What populates a row** — every count, rule, case and coverage gap — is derived from
what is really in the repository: real `describe`/`it` blocks, real import graphs, real
merged coverage. None of it is ever invented.

So a row at zero across the board is not a bug: the registry knows the area's name and
nothing has tested it yet. If a row looks wrong or unexpected, `concepts.json` is always
the first place to look.

## Reading the page

- **Every count is its own click target**, not just the row: a level's count opens that
  concept's Rules tab filtered to that level; a gap count jumps to its tab; the concept's
  name shows everything.
- **A row that holds other rows shows two numbers**: its own, then its whole subtree's in
  brackets, so collapsing one never reads as an untested part of the product. Files and
  branches are counted once per file rather than summed, so a file backing two areas under
  the same row is counted once — while two uncovered paths on one line stay two gaps. The
  masthead's totals use the same counting, so a page total is never smaller than a row
  beneath it. Collapse all / expand all are in the first column's header.
- **No checkmark next to a case.** This tool never runs the suite, so it has no pass/fail
  fact to show. Only "not written yet" (a `.todo`) gets a mark, which the AST does know.
- **A `.each` case shows its template with real values substituted** where they are
  statically known (`'$situation'` → `'without a request id'`).
- **Rules group under their level** rather than one flat list.
- **One "Copy prompt for missing tests" per concept**, covering every gap as plain file
  paths and pointing at this repo's test strategy to decide which need a test. It never
  embeds a snippet or suggests what to assert: a handful of import lines is not enough to
  judge that, so the judgment stays with whoever pastes the prompt.

## How a report gets built

```
analyze(repo)  →  Model  →  renderHtml(Model)  →  out/index.html
   (src/analyze/)  (src/model.js)   (src/render/)
```

1. **`analyze/workspace.js`** reads `pnpm-workspace.yaml` and walks every package for its
   source files and test files.
2. **`analyze/rules.js`** statically parses each test file's AST — never runs the suite —
   to find every `describe`/`it`, mapping the folder to one of the seven columns
   (`apps/api/tests/unit` → L1, `apps/web/tests/service` → F2, `tests/e2e` → F3, a
   connector's `tests/contract` → Contract).
3. **`analyze/concepts.js`** loads `concepts.json`, matches every source file to the
   area(s) whose patterns cover it — a file can match more than one, which is expected —
   and builds the tree from each entry's `parent`.
4. **`analyze/ast.js`** resolves every test file's real (non-type-only) imports, which is
   the basis for "files nothing runs".
5. **`analyze/coverage.js`** merges each package's `coverage/coverage-final.json` if
   present, to find branches no test path took.
6. **`analyze/index.js`** orchestrates the above into one `Model`, plus a `commitUrl`
   from the `origin` remote and a source-context snippet per file:line reference.
7. **`render/html.js`** and **`render/client.js`** turn the Model into the page: a static
   skeleton plus a little browser JS reading `window.__MODEL__`. No build step.

`--json` stops after step 6 and writes the Model itself — useful for another consumer, or
for diffing one run against another.

## The concepts.json CI check

`pnpm test:explorer:check` runs the full analysis and fails if any test's outer
`describe` names a feature area not in `concepts.json` — a typo, or an unregistered area.
It does **not** fail on a row full of zeros, and it does not gate on report content.

## Coverage

"Branches nothing takes" needs instrumented coverage; there is no way around running the
suite for that one column.

```bash
pnpm test:coverage   # from the repo root — runs every package's test:coverage script
```

`apps/api` uses the `istanbul` provider rather than `v8`, because the Workers runtime its
tests run inside has no `node:inspector` Session API for V8's native coverage to attach
to. `apps/web` and `packages/shared` use `v8`. Both emit the same shape, so the merge
step needs no provider-awareness.

## Known limitations

- **HTTP-driven integration tests undercount "files nothing runs."** A test calling the
  real Worker over HTTP exercises the whole pipeline without importing those files, so
  they can appear as false positives. The report warns by name when it detects the
  pattern rather than guessing which files an HTTP call reached.
- **`` it.each`template`(...) `` is not recognized**; the array form is. Neither is used here today.
- **L3 and Contract read `n/a` everywhere.** L3 needs a second backend service to mean
  anything and Contract needs a real connector package. Both are derived from real
  workspace data, so they light up on their own.

## Tests

`tools/test-explorer/tests/unit/` and `tests/integration/`, run with `pnpm test` from the
repo root or `pnpm --filter @cockpit/test-explorer test`. They cover the glob matcher and
tree-building, rule and case extraction including the `.each`, `.skip`/`.only` and
empty-describe cases, the coverage merge, and one fixture-repo test exercising `analyze()`
end to end.
