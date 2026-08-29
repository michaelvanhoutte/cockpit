# Test Explorer

Answers, without reading the code: which parts of the product own which
tests, at which of the six testing-strategy levels, and which files or
branches nothing currently exercises. Generates a single self-contained
HTML page from the repository as it exists right now — no separate model to
keep in sync by hand.

The full design rationale — why it's shaped this way, what was tried and
rejected, and the history of changes made from real feedback — lives in
[docs/test-explorer-spec.md](../../docs/test-explorer-spec.md). This file is
the shorter, practical "how do I run this and what does it actually read"
version.

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

`out/index.html` is a real, complete file — open it directly in a browser
(no server needed). It's gitignored; regenerating it never needs a commit.

For the "branches nothing takes" column to show real data instead of
`unknown`, run `pnpm test:coverage` first (see [Coverage](#coverage) below).

## Where the rows come from — and where the counts come from

These are two different questions, easy to conflate, and worth being
explicit about since the tool's whole point is deriving structure rather
than hand-maintaining it:

**Which rows exist at all** comes entirely from
[`concepts.json`](./concepts.json), the checked-in area registry — not from
test files. An entry can be declared with an empty `sourcePatterns: []`
*ahead of* any code or tests that will eventually back it (`Dashboards`,
`Panels`, `Focus`, ... are exactly this today), so a row can genuinely have
zero rules and zero everything, on purpose, while a feature is still
unbuilt. An entry can also carry `"parent": "<key>"` to nest under another
entry, turning the flat list into a tree — again, purely a registry
decision, unconnected to whether any test exists yet.

**What actually populates a row** — the L1/L2/L3/F1/F2/F3/Contract counts,
the individual rules and their cases, "files nothing runs," "branches
nothing takes" — is entirely derived from what's really in the repository:
real `describe`/`it` blocks in test files, real import graphs, real merged
coverage data. None of that is ever invented.

So a row appearing with every column at zero is not a bug and not
fabricated data — it means the registry knows the area's name (because
someone wrote it down, thinking ahead) but nothing has tested it yet. If you
see a row with real numbers you don't recognize, or a row you don't expect
to exist, `concepts.json` is always the first place to look — it's a
plain, readable, human-maintained file precisely so this stays inspectable.

## Reading the page

Every count in the tree is its own click target, not just the row: click a
level's count (L1, L2, ...) to open that concept's Rules tab filtered to
just that level; click "files nothing runs" or "branches nothing takes" to
jump straight to that tab; click the concept's own name to see everything.
No checkmark appears next to a case — this tool never runs the suite, so it
has no pass/fail fact to show; only "not written yet" (a `.todo`) gets a
mark, since that's a fact the AST does know. A `.each(table)(name, fn)` case
shows its template with the row's real values substituted in where they're
statically known (`'$situation'` → `'without a request id'`), not the raw
`$situation` placeholder. The Rules tab groups cases under their level
(L1, L2, ...) rather than one flat list.

A concept's file/branch gap counts are always visible at the top of its
panel, not just inside their own tab, and clicking either jumps straight to
it. Each entry in the Files/Branches tabs has a "Copy prompt to write a
test" button — it assembles a ready-to-paste prompt from real data (the
file, line, source snippet, and feature-area name) pointing at this repo's
testing skill/strategy; it never invents what the test should assert, since
this report stays fact-only (see the spec's §2g for why).

## How a report gets built

```
analyze(repo)  →  Model  →  renderHtml(Model)  →  out/index.html
   (src/analyze/)  (src/model.js)   (src/render/)
```

1. **`analyze/workspace.js`** reads `pnpm-workspace.yaml` and walks every
   package for its source files (`src/**`) and test files (`tests/<level>/**`).
2. **`analyze/rules.js`** statically parses each test file's AST (never runs
   the suite) to find every `describe`/`it`, mapping the test file's folder
   to one of the seven columns (`apps/api/tests/unit` → L1,
   `apps/web/tests/service` → F2, `tests/e2e` at the repo root → F3, a
   connector's `tests/contract` → Contract, ...).
3. **`analyze/concepts.js`** loads `concepts.json`, matches every source file
   to the area(s) whose glob patterns cover it (a file can match more than
   one — see the spec's §2a for why that's expected), and builds the tree
   from each entry's `parent`.
4. **`analyze/ast.js`** resolves every test file's real (non-type-only)
   imports to figure out which source files are actually exercised by
   *something* — the basis for "files nothing runs."
5. **`analyze/coverage.js`** merges each package's `coverage/coverage-final.json`
   (if present) to find branches no test path ever took.
6. **`analyze/index.js`** is the orchestrator: ties the above together into
   one `Model` (defined in `src/model.js`), plus a `commitUrl` derived from
   the `origin` git remote and a source-context snippet for every file:line
   reference, so the report can show real code inline.
7. **`render/html.js`** and **`render/client.js`** turn that `Model` into the
   page — a static skeleton plus a small amount of browser JS that reads the
   model embedded in the page (`window.__MODEL__`) to draw the tree and the
   detail panel. No build step, no bundler.

`--json` stops after step 6 and writes the `Model` itself
(`out/model.json`) instead of rendering it — useful for a different
consumer, or for diffing one run against another.

## The concepts.json CI check

`pnpm test:explorer:check` (`--check-concepts`) runs the full analysis and
fails if any test's outer `describe` names a feature area that isn't in
`concepts.json` — a typo, or a new area nobody registered yet. It does
**not** fail on a row full of zeros, and it does not gate on report content
at all (see the spec's §8 for why that's deliberate).

## Coverage

"Branches nothing takes" needs real, instrumented coverage data — there is
no way around actually running the suite for that one column. Run:

```bash
pnpm test:coverage   # from the repo root — runs every package's test:coverage script
```

`apps/api` uses the `istanbul` provider rather than `v8`: the Cloudflare
Workers runtime its tests run inside has no `node:inspector` Session API for
V8's native coverage to attach to. `apps/web` and `packages/shared` use `v8`.
Both emit the same coverage-final.json shape, so the merge step doesn't need
to know which provider produced which file.

## Known limitations

- **HTTP-driven integration tests undercount "files nothing runs."** A test
  that calls the real Worker over HTTP (`SELF.fetch`, per
  `apps/api/tests/integration/http/*.test.ts`) genuinely exercises the whole
  request pipeline without ever importing those files directly — so they can
  show up as false positives in that column. The report warns about this by
  name when it detects the pattern; it doesn't try to guess which files an
  HTTP call actually reached.
- **`it.each\`template\`(...)` (tagged-template form) isn't recognized.**
  `it.each([...])(...)` (array/table form) is. Neither is used in this repo
  today.
- **L3 (system) and Contract read `n/a` everywhere right now.** L3 needs a
  second backend service to mean anything (testing-strategy.md §2); Contract
  needs a real connector package. Both are derived from real workspace data,
  not hand-toggled, so they'll light up on their own the day either exists.

## Tests

`tools/test-explorer/tests/unit/` — run with `pnpm test` from the repo root,
or `pnpm --filter @cockpit/test-explorer test` directly. Covers the glob
matcher and tree-building (`concepts.js`), rule/case extraction including
the `.each`, `.skip`/`.only`, and empty-describe edge cases (`rules.js`),
the coverage merge (`coverage.js`), and one fixture-repo test exercising the
whole `analyze()` pipeline end to end (`index.js`).
