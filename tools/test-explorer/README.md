# Test Explorer

Answers, without reading the code: which parts of the product own which tests, at which
testing-strategy level, and which branches nothing exercises. Writes the model from the
repository as it exists right now; the Harness Monitor's Tests page draws it.

The design rationale — what was tried and rejected, and why it is shaped this way —
lives in [docs/test-explorer-spec.md](../../docs/test-explorer-spec.md). This is the
practical "how do I run it and what does it read" version.

## Reading it without running it

On the Harness Monitor, at `/tests`. [deployment.md](../../docs/deployment.md), "The environments", says where
the Monitor is and what became of the old address, the root of the GitHub Pages site.

The Monitor holds `main`'s latest model and keeps no history: the `Tests snapshot` job sends the model
`Test Explorer` wrote with `--model`, as the tree without source lines, then each area's source lines,
then the switch that shows them. An open pull request's latest model goes there too, sent with
`--pull-request` by `.github/workflows/pr-tests.yml` from its run's `test-explorer-model` artifact. Both
come from the `Test Explorer` job in `.github/workflows/ci.yml`.
`GET /tests?format=json` on the Monitor answers the tree it shows, and `&pr=<number>` a pull request's
("The Harness Monitor" in [docs/architecture.md](../../docs/architecture.md)).

## Running it

```bash
pnpm test:explorer          # from the repo root — writes out/model.json
pnpm test:explorer:check    # fails if a test names a feature area not in concepts.json, or not-worth-a-test.json has an entry it cannot place
```

Or directly from this package:

```bash
cd tools/test-explorer
node src/cli.js                    # writes out/model.json
node src/cli.js --model <file>     # writes the model there instead
node src/cli.js --send <file>      # sends a model to the Harness Monitor as main's tests, with
                                   # HARNESS_MONITOR_URL and HARNESS_WRITE_KEY set
node src/cli.js --send <file> --pull-request <n>   # the same, as pull request n's tests
node src/cli.js --check-concepts   # the CI check, see below
node src/cli.js --repo <path>      # analyze a different checkout
node src/cli.js --help
```

`out/model.json` is gitignored. For the "branches nothing takes" figures to hold real data
instead of `unknown`, run `pnpm test:coverage` first.

## Where the rows come from — and where the counts come from

Two different questions, easy to conflate:

**Which rows exist** comes entirely from [`concepts.json`](./concepts.json), the
checked-in area registry, not from test files. An entry can be declared with empty
`sourcePatterns` *ahead of* any code that will back it (`Focus`, `Connector management`
and `User management` are exactly this today), and can carry `"parent": "<key>"` to nest
under another entry — which is what makes the rows read as the product's own containment,
a Workspace holding an Inbox and Dashboards, a Dashboard holding Panels. Both are
registry decisions, unconnected to whether any test exists.

**What populates a row** — every count, rule, case and coverage figure — is derived from
what is really in the repository: real `describe`/`it` blocks and real merged coverage. None of it is ever invented.

So a row at zero across the board is not a bug: the registry knows the area's name and
nothing has tested it yet. If a row looks wrong or unexpected, `concepts.json` is always
the first place to look.

## How a run goes

```
analyze(repo)  →  Model  →  out/model.json
   (src/analyze/)  (src/model.js)     sendSnapshot(Model)  →  the Harness Monitor, with --send
```

1. **`analyze/workspace.js`** reads `pnpm-workspace.yaml` and walks every package for its
   source files and test files.
2. **`analyze/rules.js`** statically parses each test file's AST — never runs the suite —
   to find every `describe`/`it`, mapping the folder to one of the seven columns
   (`apps/api/tests/unit` → L1, `apps/web/tests/service` → F2, `tests/e2e` → F3, a
   connector's or `apps/api`'s `tests/contract` → Contract).
3. **`analyze/concepts.js`** loads `concepts.json`, matches every source file to the
   area(s) whose patterns cover it — a file can match more than one, which is expected —
   and builds the tree from each entry's `parent`.
4. **`analyze/ast.js`** parses each test file once for the rule extraction.
5. **`analyze/coverage.js`** merges each package's `coverage/coverage-final.json` if
   present, to find branches no test path took and give each area file its statements,
   how many ran and the lines none ran.
6. **`analyze/index.js`** orchestrates the above into one `Model`, plus a `commitUrl`
   from the `origin` remote and a source-context snippet per file:line reference.
The run stops after step 6 and writes the Model itself; the Harness Monitor draws it.

## The concepts.json CI check

`pnpm test:explorer:check` runs the full analysis and fails if any test's outer
`describe` names a feature area not in `concepts.json` — a typo, or an unregistered area.
It also fails on an entry of [`not-worth-a-test.json`](./not-worth-a-test.json) naming a file the
analyzer does not walk, giving no reason, or with no count of statements not run. It does
**not** fail on a row full of zeros, and it does not gate on report content.

## Files decided not worth a test

[`not-worth-a-test.json`](./not-worth-a-test.json), beside `concepts.json`, lists the source
files judged not worth a test (wiring, a type, a log line): each one's path as the analyzer
walks it, the reason, in a sentence a reviewer can disagree with, and how many of its
statements CI's coverage run on main left unrun when it was decided (`notRun`): the Test
coverage page's Statements not run for it, or its `total` less `covered` in the model
`pnpm test:coverage` then `node tools/test-explorer/src/cli.js` writes. Whoever acts on a prompt copied from the Harness Monitor's Test coverage page writes the
entry, in the pull request that decides it, so the decision is reviewed like code. The
analyzer carries the list into the model, where the Monitor's Gaps tab shows the file under
Decided not to test with its reason, until more than `notRun` of its statements go unrun and
it returns to Files to test next, marked changed since decided.

## Coverage

"Branches nothing takes", and each area file's statements run that the Harness Monitor
draws as Covered, need instrumented coverage; there is no way around running the suite
for them.

```bash
pnpm test:coverage   # from the repo root — runs every package's test:coverage script
```

`apps/api` uses the `istanbul` provider rather than `v8`, because the Workers runtime its
tests run inside has no `node:inspector` Session API for V8's native coverage to attach
to. `apps/web` and `packages/shared` use `v8`. Both emit the same shape, so the merge
step needs no provider-awareness.

## Known limitations

- **`` it.each`template`(...) `` is not recognized**; the array form is. Neither is used here today.
- **L3 reads `n/a` everywhere.** It needs a second backend service to mean anything, and
  is derived from real workspace data, so it lights up on its own.
- **Contract reads `n/a` for an area no contract suite names**, not 0. Every live contract
  suite counts, in `apps/api/tests/contract/` or a connector's `tests/contract/`, under the
  area its outer `describe` names.

## Tests

`tools/test-explorer/tests/unit/` and `tests/integration/`, run with `pnpm test` from the
repo root or `pnpm --filter @cockpit/test-explorer test`. They cover the glob matcher and
tree-building, rule and case extraction including the `.each`, `.skip`/`.only` and
empty-describe cases, the coverage merge, one fixture-repo test exercising `analyze()`
end to end, and `concepts-registry.test.js`, which holds `concepts.json`'s non-glob
patterns to files the analyzer really walks.
