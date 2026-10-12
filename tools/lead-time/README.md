# Lead time

Answers, without querying the API by hand: **how long does a change spend being written
against waiting on the harness, how many rounds does it take, and which check holds each
round up.** Reads the pull request and Actions APIs and each pull request's session record
("Record what a session did, on the pull request it opens", issue 514), and draws them as one
HTML page that opens from disk, or with `--json` writes the model. Keeps no state — GitHub
already stores this history, so every run re-derives it.

## Reading it without running it

Built once a night by the `Lead time` job of
[`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml), which says why it is not
per merge, and by hand from the Actions tab when a night was missed. It is uploaded as the
`lead-time-report` artifact, and that same run's own `Publish` job takes it live into
**<https://michaelvanhoutte.github.io/cockpit/lead-time/>**, beside the test explorer, the
[CI stability page](../ci-stability/README.md), the [test-selection page](../selection/README.md) and the
[architecture page](../architecture/README.md) —
the same night, not waiting on the next merge. A missing artifact costs this page and never the site.
The published site carries `model.json` beside the page.

## Running it

```bash
pnpm lead-time            # from the repo root — writes tools/lead-time/out/index.html
pnpm --filter @cockpit/lead-time model   # the model instead, at out/model.json
```

```bash
cd tools/lead-time
node src/cli.js                       # over 7 and 14 days
node src/cli.js --windows 1,7         # different windows
node src/cli.js --max-pulls 40        # stop at 40 pull requests, and report the period it reached
node src/cli.js --repo owner/name     # a different repository
node src/cli.js --model out/model.json   # writes the page and, beside it, the model
node src/cli.js --help
```

A token is taken from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`; without one the API allows
60 requests an hour, which is not enough for a window.

## What the model says

A pull request is one line, cut into parts:

| Part | From | To |
|---|---|---|
| Before the first push | the session's start where recorded, else the first commit's author date | the first push |
| A round, each | a push | the last check that ran finishing, never past the next push |
| Fixing | a round finishing | the next push |
| Waiting to merge | the last round finishing | the merge |
| Away | any gap of over three hours, in place of fixing or waiting | |

- **A push is a commit that had checks run on it**, at the earliest moment any check on it was
  seen — the API records when a check started, never when a push arrived. A commit no check ran
  on, or only skipped ones, went out with the next push and is counted in that round's `commits`.
  A queued check's wait is therefore inside the round, not before the push.
- **A round says what held it.** Each check is charged the time since the previous one finished,
  so two checks in flight together count once, and the last to finish is named (`last`).
- **A round is red when a check ended failed.** What a check ended as is its last attempt, so a
  failure that was re-run to a pass is a **fluke** — same commit, `filter=all` shows the earlier
  attempts — and not a red round. Its cost is the time from the failed attempt finishing to the
  passing one finishing. A failure the next push fixed is a red round; two jobs that share a
  name in different workflows are two checks, not one re-run.
- **A failed attempt names what it failed on.** Every failed attempt of a red round or a fluke
  carries, in the round's `failures`, the steps its job ended failed at and, for `Test` and
  `E2E (F3)`, the test files its own `test-selection-record` or `e2e-selection-record` marks
  failed. A record is matched to its attempt by being created during that attempt's job (30
  seconds' slack after it ends), since a re-run uploads a second artifact of the same name. An
  attempt whose record expired, was never uploaded, matches two artifacts or could not be read reads
  `not-recorded` with its `why`, never as failing nothing, and a package that wrote no report is named in
  `packagesNotRecorded`. An error reading a failed attempt never drops its pull request; only a spent rate limit there fails the run.
- **A round splits queued from running, per check.** A CI job's queue is its creation to its start,
  from the run's job list (`filter=all`), read once per CI run; a job waiting on `needs:` is created
  when its dependency finishes, so that wait is never queue. A re-run copies its passed jobs with a
  start before their creation; a copy is neither queued nor run time. A round carries `queued`
  (per check, in ms), and `queueNotRecorded` where a job list could not be read: the pull request
  stays in every figure, and so does one where the rate limit is spent while reading them: the checks not yet read read `not-recorded` with `why: 'rate-limit'` and the run goes on. A CI check outside what the listing of CI runs reaches reads `not-recorded` too (`outside-listing`). Only the CI workflow's runs are read.
- **Cancelled runs count the runner minutes they used**, start to end, none if never started. A
  pull request's `cancelled` splits them into `superseded` (a later push arrived before the run
  ended, or within five seconds after, which is how soon a push is seen) and `other`; `runnerMs` is
  every attempt that ran.
- **A local review is a slice of the gap it sat in.** The session record's `review-start` and
  `review-end` of one kind pair into a review; the pull request's `reviewSlices` cut each to the
  gaps it ran in (before the first push, and between a round and the next push), so a review
  marked across a push or a round counts only its parts in the gaps either side, and one inside a
  gap long enough to read as away counts in neither. Where two overlap, the later starts where the
  earlier ended. The strip draws the slices and the scatter's harness adds them, so the two agree to
  the minute. Review checks (`claude-review`, `Security review`) were removed in "Remove the
  remote code and security reviews" (pull request 512); in older history they count under tests and
  checks like any other.
- **A local test run and the browser pass are slices too**, cut to the same gaps (`runSlices`).
  Test runs are the `test-run` lines the runners wrote into the record, the browser pass a
  `browser-start` paired with the next `browser-end`; a start with no end gives no slice. Unlike
  two reviews, these are not moved to start where another ended, so a test run during a review is
  drawn as well: the strip shows the stretch they share once, striped in both colours, and the
  harness total counts the union of every local slice once. A panel lane is a kind's own minutes, so
  lanes can add up to more than the harness total by the overlap.
- **A conclusion it does not know is neither a pass nor a fail**, and is named in the round's
  `unrecognised`.
- **Time nobody wrote down reads as not recorded, never zero.** A pull request with no record
  starts at its first commit and says so in `notes`; a record missing one phase is read for the
  rest (`notRecorded` lists what it lacks); a record whose start is after the first commit is
  ignored for its start. `localReviews` is `null` where no review was marked start and end, and
  a pull request's `harness.local` (per kind, the minutes that count) is `null` likewise. Each kind
  of `harness.local` (both reviews, `test`, `browser`) is `null` where the record has none of it,
  and so is the pull request's `localRuns` (`test` and `browser`: count and minutes as marked);
  a window's `localRuns` gives each kind's count and minutes, `null` figures where no pull request
  has any.
- **Every figure carries its counts**: `count` is the items behind it (rounds, gaps) and `pulls`
  the pull requests they came from. A window with nothing in it reads `null`, not zero, and
  `pulls.withoutRecord` says how many pull requests the record-based figures left out. A pull
  request closed without merging is in no figure.

Over each window the model gives the median and p95 of every part, `queue` (per check, `null`
where no job list was read), `cancelled` (superseded and other minutes, and `share`, cancelled
runner minutes over all runner minutes, not over round time, `null` with none; `supersededShare` is the superseded part over the same runner minutes, `null` likewise), the rounds per pull request,
how many rounds ran past ten minutes, what the checks held rounds up for (`harness`: minutes,
runs, and rounds they finished last) and the local review time (`localReviews`: count and minutes as
marked, and the minutes per kind). Each pull request carries the same `harness` shape for its own
rounds, plus `harness.local`, the review minutes per kind that count, so the page can plot one pull
request the way it reads a window. `pulls` in
the model is the per-pull-request detail behind them.

Each window's `failures` lists every failing test file and every failing step with the pull
requests it failed on and the attempts on each, most pull requests first, and counts the attempts
whose files could not be read (`notRecorded`). It is empty lists, never `null`, where nothing failed.

**Coding against the harness** is each pull request's `balance`, and over a window its `balance`
holds the dots and the median of their ratios. Coding is the time before the first push plus the
fixing between rounds, less local review; the harness is every round plus local review. Waiting to
merge and time away are in neither. It is `null` for a pull request with no record (the local
reviews would be missing from it) or with no round, and `noChecks` counts the second kind.

## The page

Every measurement on it is the model's; the renderer lays them out and sums the columns it shows. It opens with a box saying what
the totals leave out, always and not only when something is unusual: the period actually covered
(not the one asked for, where the fetch was capped), that time before the session's start is not
measured, that only merged pull requests count, and how many carry a session record. Then the
evolution panels, coding against the harness, and a strip per pull request.

- **Evolution is four panels, one point per pull request read** (not one per window), positioned
  by when it actually merged: where the harness minutes go (tests and checks, then local code and
  security review, test run, browser pass, stacked), start to merge,
  rounds to merge, and the share of a pull request's rounds that were red. A dot's size is the
  pull request's own lines changed, the same on every panel, so a trend is something to see
  rather than two window snapshots to compare by eye.

- **Coding against the harness is a scatter** (`src/render/scatter.js`): a dot per pull request
  that carries a record, minutes coding and fixing across and minutes in the harness up, on one
  scale for both axes up to two hours, sized by rounds. A dashed line marks the harness taking as
  long as the coding, a solid one the median ratio. It is drawn over the widest window only. A dot
  past the scale is hollow on the edge and marked off the chart, the three furthest above the
  dashed line are named, and a hover or focus names the pull request and its figures. Pull requests
  without a record are counted beneath it, not drawn. No line means healthy: there is no accepted
  benchmark, so the reference is the window's own median.

- **A strip is drawn on one scale for every pull request** (`src/render/strips.js`), up to four
  hours; a longer one is cut at the edge and says how much it cut. Time away is off the scale.
- **Local and CI read apart.** Local kinds (coding, fixing, each local review, test runs, the browser pass) are in greens and
  teals, CI kinds in blue, and the legend is grouped under *Local* and *CI*. Waiting to merge and
  time away are in neither. A later local kind joins the first group.
- **A pull request with no session record reads "not recorded"**, as a tag and a hatched first
  part, so it never looks like coding that took no time.
- **No script and nothing fetched**: styles are inline, and the only addresses are links a reader
  follows, to pull requests and the commit. Light and dark follow the reader's setting.

## How a page gets built

```
collect(repo)  →  buildModel(...)  →  renderHtml(model)  →  out/index.html
  (src/github.js)   (src/model.js)      (src/render/)         (out/model.json with --json)
```

`github.js` is the only file that does I/O and `model.js` the only one that computes;
`render/` draws what it is handed and `cli.js` wires them. Sessions' record format is
`scripts/lib/session-record.mjs`'s, imported rather than copied, so the two cannot drift.

**Request cost is what shapes `github.js`**, and its header comment is where that is worked out:
what each pull request and each failed attempt costs, against the 1,000 an hour a `GITHUB_TOKEN` allows.
`--max-pulls` stops rather than spending it, and the model's `coverage` reports the period it
actually reached — as does a listing that ends before the window does. A pull request whose
commits or check runs cannot be read is named in `coverage.failed` and left out; a spent rate
limit fails the run, since what comes after it would be missing for the same reason.

## Tests

The model, the page it renders and the argument parser are `tests/unit/`; the fetcher, driven through a stubbed
`fetch`, is `tests/integration/`. Nothing reaches the network, so neither needs a token.
