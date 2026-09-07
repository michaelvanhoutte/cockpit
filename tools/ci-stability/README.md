# CI Stability

Answers, without opening the Actions tab and counting: **is `main` staying green, and
which job is least reliable.** Reads the GitHub Actions API and writes one self-contained
HTML page. Keeps no state — GitHub already stores this history, so every run re-derives it.

The options considered and rejected, and the measured baseline, are in
[docs/ci-stability-options.md](../../docs/ci-stability-options.md).

## Reading it without running it

Published on every merge to `main` at
**<https://michaelvanhoutte.github.io/cockpit/stability/>** — no sign-in needed. The test
explorer is the other half of that site, at the root, and the two link to each other.

Every `main` run also uploads the page as the `ci-stability-report` artifact, from the
`Stability` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

## Running it

```bash
pnpm stability            # from the repo root — writes out/index.html
```

```bash
cd tools/ci-stability
node src/cli.js                       # writes out/index.html
node src/cli.js --json                # writes out/model.json instead
node src/cli.js --days 7              # a shorter window
node src/cli.js --windows 1,7         # different columns
node src/cli.js --repo owner/name     # a different repository
node src/cli.js --help
```

`out/index.html` is a complete file — open it directly, no server needed, and it is
gitignored. A token is taken from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`; without
one the API allows 60 requests an hour, which is not enough for a full window.

## What the numbers mean

- **A rate counts only the runs that finished.** A cancelled run is not a failed one:
  `cancel-in-progress` cancels about a quarter of this branch's jobs, and the slowest job
  is cancelled most, so folding them into failures would report the browser tier far worse
  than it is. Everything left out is counted under its own name in the last column.
- **A job with nothing finished reads "no data", not 0%**, so a job added yesterday does
  not head a worst-first list.
- **Every percentage carries its counts.** A rate over eleven runs and one over four
  hundred are different claims.
- **A workflow's rate is its own**, not the mean of its jobs: nine jobs passing and one
  failing is a failed run.
- **A red stretch runs from a failing run to the next passing one.** Consecutive failures
  are one stretch; a cancelled run in between neither opens nor closes one.
- **Durations exclude cancelled jobs**, which are truncated and would drag the median
  down. One run is reported as both its median and its p90, which is all one run can say.
- **A conclusion the model does not recognise is counted as neither pass nor fail**, and
  named on the page. Silently reading a new conclusion as success is the one way this
  report could mislead in the reassuring direction.

## How a report gets built

```
collect(repo)  →  buildModel(...)  →  renderHtml(Model)  →  out/index.html
  (src/github.js)   (src/model.js)      (src/render/)
```

`github.js` is the only file that does I/O and `model.js` the only one that computes;
`render/` imports the model and never the fetcher. `--json` stops after the second arrow.

**Cost shapes `github.js`.** Job detail is one request per run and `GITHUB_TOKEN` is
capped at 1,000 requests an hour *per repository*, shared with every other workflow. Thirty
days of `main` is about 400 requests once skipped runs are dropped — they ran no jobs, so
there is nothing to ask about. `--max-runs` is the budget that keeps it true if the merge
rate climbs: it stops early and the page reports the shorter window it actually read.

This is why the `Stability` job runs on `main` only. What proves the generator on a branch
is its own suite, which stubs the API.

## What it deliberately does not answer

Which *test* is unreliable, and any number called flakiness. Both need per-test results —
reporters in every suite, a store outliving artifact expiry, and a scheduled repeat run
against an unchanged `main` — scoped as the second and third slices in the options
document. A job can also fail because the stack fell over rather than because a test did,
and at job level those are indistinguishable.

## Tests

`tests/unit/` and `tests/integration/`, run with `pnpm test` from the repo root or
`pnpm --filter @cockpit/ci-stability test`. The API is stubbed everywhere, so the suite
needs no network and no token.
