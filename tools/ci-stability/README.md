# CI Stability

Answers, without opening the Actions tab and counting: **is `main` staying green, and
which job is least reliable.** Reads the GitHub Actions API and writes one self-contained
HTML page. Keeps no state — GitHub already stores this history, so every run re-derives it —
and with `--send` hands the runs to the Harness Monitor, which keeps them past GitHub's 90 days.

The options considered and rejected, and the measured baseline, are in
[docs/ci-stability-options.md](../../docs/ci-stability-options.md).

## Reading it without running it

Published on every merge to `main` at
**<https://michaelvanhoutte.github.io/cockpit/stability/>** — no sign-in needed. The test
explorer is at the root, the [cycle-time page](../cycle-time/README.md) at `/cycle-time/` and the
[test-selection page](../selection/README.md) at `/selection/`; those four link to one another, and the
[architecture page](../architecture/README.md) at `/architecture/` links to them.

Every `main` run also uploads the page and model as the `ci-stability-report` artifact, from the
`Stability` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). The published
site carries `model.json` beside the page.

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
node src/cli.js --model out/model.json   # writes the page and, beside it, the model
node src/cli.js --help
```

```bash
node src/cli.js --send                                  # also sends the runs to the Harness Monitor
node src/cli.js --send --from 2026-07-25 --to 2026-08-24   # sends that window only, writes nothing
```

`--send` needs `HARNESS_MONITOR_URL` and `HARNESS_WRITE_KEY`, and sends each run with its jobs
and steps, counted as this page counts them, from the newest run the Monitor holds less two
days. The `Stability` job does it on every merge; the backfill is the *Stability backfill*
workflow ([deployment.md](../../docs/deployment.md), "The Harness Monitor").

It also sends every attempt of those runs, a re-run's each its own, from the newest attempt the
Monitor holds less two days (the last 30 days when it holds none). An attempt carries its verdict
(an earlier one's read from its own jobs), the branch and pull request it ran for, and on `main` its
jobs and steps. Each failed job carries the tests that failed in it, read from the record the job
uploaded during that attempt (`test-selection-record`, `e2e-selection-record`, or
`failed-tests-record`); a job with no record, an expired one or one that cannot be read keeps its
failed step and names no test. Dependabot's runs, named for their update, are one workflow,
`Dependabot`, whose jobs are read only where the run failed. A re-run costs a request for each
earlier attempt, and a failed job with a record two more.

```bash
node src/cli.js --branches --send                       # every other branch's attempts, no page
node src/cli.js --branches --send --from 2026-10-01     # that window, whatever the Monitor holds
```

`--branches` sends every attempt of every run on a branch other than `main`'s (a pull request's run,
or a push to another branch) and nothing else: no page, no run. It is the `Branch attempts` job in
[`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml), every night. It starts from the
newest *branch* attempt the Monitor holds less two days (`GET /v1/ci-attempts?on=branches`), so
`main`'s send never moves it, and goes a day at a time, oldest first: list the day's runs by their
`created` time (GitHub's `branch=` filter is exact, and a list ends at 1,000 runs, so a fuller span
is read as halves), read the jobs of the attempts that failed and each earlier attempt of a re-run,
send. A branch attempt keeps its verdict, branch, pull request and failed jobs with their tests, and
no passing job or step. A day sent stays stored whatever stops the next; `--max-runs` stops it after
the day that reaches it, and a stop of any kind fails the run, naming where, for the next night to
carry on from. A re-run's attempt, which carries the time it started, is sent after the last day
when that is later than its run's day, so a stop leaves it unsent and says `--from` sends it.

A run's `pull_requests` list is empty on GitHub once its pull request has closed. The Monitor keeps the pull
request an attempt was stored with, so only a run first read after that is stored with its branch alone.

`out/index.html` is a complete file — open it directly, no server needed, and it is
gitignored. A token is taken from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`; without
one the API allows 60 requests an hour, which is not enough for a full window.

## What the numbers mean

- **A rate counts only the runs that finished.** A cancelled run is not a failed one:
  `cancel-in-progress` cancels about a quarter of this branch's jobs, and the slowest job
  is cancelled most, so folding them into failures would report the browser tier far worse
  than it is. Everything left out is counted under its own name in the last column.
- **The last run is the most recent one that passed or failed**, per workflow and per job, so a
  newer cancelled, skipped or running one never hides a red. It reaches back over every run
  fetched rather than a window, and a job's can be older than its workflow's when the latest run
  skipped it. Each cell links to that run; none finished reads "no data".
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
- **A job that runs as shards is one job.** `E2E (F3) (1)` to `(4)` and the fan-in named `E2E (F3)` are one row under the fan-in's name, one occurrence per run with the fan-in's verdict, and its duration is the first shard's start to the last shard's end. A shard that did not finish, a shard missing from the list (seen as a gap in the numbering, so a missing last shard is not) or no fan-in leaves that run's duration out, never the span of the shards that were read. The failing step is the failing shard's, and a fan-in skipped behind a failed shard reads as that failure.
- **Each job's steps carry the same median and p90**, read from the job list already
  fetched. A step is keyed by its name and its occurrence of that name in the job (the 1st
  and 2nd "Upload"), because step numbers shift when a step is inserted; rows run in the
  order of the step's median position across the runs that have it. Skipped and cancelled
  steps, steps with no start or end, and every step of a job that did not pass or fail are
  left out, so a step seen only in cancelled jobs has no row. A step with nothing counted
  reads "no data", not 0. The model carries them; the page does not draw them yet.
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

**Request cost is what shapes `github.js`**, and its header comment is where that is worked
out. It is also the reason for `--max-runs` and for the `Stability` job running on `main`
only; what proves the generator on a branch is this package's own suite, which stubs the API.

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
