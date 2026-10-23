# Cycle time

Answers, without querying the API by hand: **how long does a change spend being written
against waiting on the harness, how many rounds does it take, and which check holds each
round up.** Reads the pull request and Actions APIs and each pull request's session record
("Record what a session did, on the pull request it opens", issue 514), and draws them as one
HTML page that opens from disk, or with `--json` writes the model. Keeps no state of its own —
GitHub already stores this history, so every run re-derives it — and with `--send` hands each merged
pull request to the Harness Monitor, which keeps them past what GitHub holds.

## Reading it without running it

Built once a night by the `Cycle time` job of
[`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml), which says why it is not
per merge, and by hand from the Actions tab when a night was missed. It is uploaded as the
`cycle-time-report` artifact, and that same run's own `Publish` job takes it live into
**<https://michaelvanhoutte.github.io/cockpit/cycle-time/>**, beside the test explorer, the
[CI stability page](../ci-stability/README.md), the [test-selection page](../selection/README.md) and the
[architecture page](../architecture/README.md) —
the same night, not waiting on the next merge. A missing artifact costs this page and never the site.
The published site carries `model.json` beside the page.

## Running it

```bash
pnpm cycle-time            # from the repo root — writes tools/cycle-time/out/index.html
pnpm --filter @cockpit/cycle-time model   # the model instead, at out/model.json
```

```bash
cd tools/cycle-time
node src/cli.js                       # over 7 and 14 days
node src/cli.js --windows 1,7         # different windows
node src/cli.js --max-pulls 40        # stop at 40 pull requests, and report the period it reached
node src/cli.js --repo owner/name     # a different repository
node src/cli.js --model out/model.json   # writes the page and, beside it, the model
node src/cli.js --help
```

A token is taken from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`; without one the API allows
60 requests an hour, which is not enough for a window.

## Where its rows go

```bash
node src/cli.js --send                                  # also sends the merged pull requests to the Harness Monitor
node src/cli.js --send --from 2026-07-25 --to 2026-08-05   # sends that window instead, and writes nothing
```

`--send` needs `HARNESS_MONITOR_URL` and `HARNESS_WRITE_KEY`. It sends each pull request merged since
the newest merge the Monitor holds less two days (the last `--days` days when it holds none) as one
row with its time split, its rounds and each round's checks, from `monitorRows` in `src/model.js`.
A pull request with no session record is sent with its writing and local time `null`, which the
Monitor stores and answers as not recorded, never as zero. A pull request is replaced by its number, so
the overlap and a re-send store each once, and a batch with a row of the wrong shape is refused whole.
A read the pull budget (`--max-pulls`) stopped inside the send's window fails the step and names the
`--from` and `--to` that send the rest. So does a pull request GitHub would not let it read, named in
the message, since once a later merge is stored the next send reaches past it. An attempt's failed
steps and files are cut to their first 500, each to 500 characters, as the Monitor takes no more.

The `Cycle time` job in [`nightly.yml`](../../.github/workflows/nightly.yml) sends every night. The
backfill is the *Cycle time backfill* workflow, run by hand
([deployment.md](../../docs/deployment.md), "The Harness Monitor", says how to cover 90 days). The
Monitor answers what it holds as JSON at `/cycle-time?format=json`, for a period (`?period=7d`, `30d`,
`90d` or `all`): each window's figures (7, 14, 30 and 90 days up to the period) and every pull request in
it with its rounds and checks.

## Which pull requests it reads

Pull requests merged into `main` or any `feature/*` branch, from one listing of closed pull requests
with no base filter, so a feature branch costs no request of its own; units count against
`--max-pulls` like any other. Each carries its `base` and `head`, and the page marks a row whose base
is not `main`. A pull request from a `feature/*` branch into `main` is a **landing**: shown, marked,
and left out of every window figure, the scatter and the evolution panels (`landing: true` in the
model), since its units were each a pull request into the branch and are counted there. `--branch`
names the trunk (default `main`): the base that is not marked, and the one a landing merges into.

## What the model says

A pull request is one line, cut into parts:

| Part | From | To |
|---|---|---|
| Before the first push | the session's start where recorded, else the first commit's author date | the first push |
| A CI Round, each | a push | the last check that ran finishing, never past the next push |
| Fixing | a round finishing | the next push |
| Waiting to merge | the last round finishing | the merge |
| Away | any gap of over three hours, in place of fixing or waiting | |

- **A push is a commit that had checks run on it**, at the earliest moment any check on it was
  seen — the API records when a check started, never when a push arrived. A commit no check ran
  on, or only skipped ones, went out with the next push and is counted in that round's `commits`.
  A queued check's wait is therefore inside the round, not before the push.
- **A round says what held it.** Each check is charged the time since the previous one finished,
  so two checks in flight together count once, and the last to finish is named (`last`).
- **A shard family is one check.** A job named for a family and a shard index (`E2E (F3) (1)`, which is what GitHub names a matrix job `E2E (F3)` over a `shard` dimension) belongs to the family `E2E (F3)`, whose fan-in is the job named exactly that. The round names the family, which is red, a fluke, queued or failed once: its attempts are the fan-in's, a failure takes its steps from the failing shards and its record from the fan-in's merged artefact, and its queue is its longest shard's. A fan-in skipped behind a failed shard reads as that failure. A family whose list is not whole (a shard missing, seen as a gap in the numbering, so a missing last shard is not; no fan-in; a shard's job list unread) has its queue `not-recorded`, never the longest of the shards that were read. One `E2E (F3)` job with no shards reads as it always did.
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
- **A round carries a lane per job that ran** (`lanes`): its start and stop inside the round, and its queue as a lead before the start, cut at the round's start. A skipped job, a re-run's copy and a job cancelled before a runner took it have none; a re-run of a job is its own lane, `rerun`. A round where any job's list was not read, or where no job drew a lane, has `lanes: null` and draws as one block.
- **Cancelled runs count the runner minutes they used**, start to end, none if never started. A
  pull request's `cancelled` splits them into `superseded` (a later push arrived before the run
  ended, or within five seconds after, which is how soon a push is seen) and `other`; `runnerMs` is
  every attempt that ran.
- **A local review is a slice of the gap it sat in.** The session record's `review-start` and
  `review-end` of one kind pair into a review; the pull request's `reviewSlices` cut each to the
  gaps it ran in (before the first push, and between a round and the next push), so a review
  marked across a push or a round counts only its parts in the gaps either side, and one inside a
  gap long enough to read as away counts in neither. A review keeps its own marked interval, so two
  that ran in parallel overlap; the strip draws them as lanes and the harness counts their shared
  minutes once, so the two agree to the minute. A pull request's `localReviews.ms` is its review wall
  clock, shared minutes once, and `byKind` each kind's own count and minutes. In a record where two
  reviews of different kinds have end marks within a second of each other, the ends were written
  together: both are drawn at the recorded shared length, flagged `endedTogether`, and the hover says
  its own length is not recorded. Review checks (`claude-review`, `Security review`) were removed in "Remove the
  remote code and security reviews" (pull request 512); in older history they count under tests and
  checks like any other.
- **A local test run and the browser pass are slices too**, cut to the same gaps (`runSlices`).
  Test runs are the `test-run` lines the runners wrote into the record, the browser pass a
  `browser-start` paired with the next `browser-end`; a start with no end gives no slice. A test
  run during a review is drawn as well. Where local work runs in parallel the strip splits into one
  full-height lane per thread: the longest on the strip's line, the rest above it, then below (ties
  fall to the order code review, security review, test run, browser pass). The harness total counts the union of every local slice once. A panel lane is a kind's own minutes, so
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
holds the dots, each with its lines changed, and the median of their ratios. Coding is the time before the first push plus the
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
  scale for both axes up to two hours. A dot's size is its lines changed, 4 to 14px by the square root
  over the window's largest, and its shade is its CI rounds in five steps, blue for one round to red for
  five or more. A dashed line marks the harness taking as
  long as the coding, a solid one the median ratio. It is drawn over the widest window only. A dot
  past the scale is hollow on the edge and marked off the chart, the three furthest above the
  dashed line are named where their labels fit (a label takes the first free place right, left or below
  its dot, and is left off when none is), and a hover or focus names the pull request and its figures. Pull requests
  without a record are counted beneath it, not drawn. No line means healthy: there is no accepted
  benchmark, so the reference is the window's own median.

- **A strip is drawn on one scale for every pull request** (`src/render/strips.js`), up to four
  hours; a longer one is cut at the edge and says how much it cut. Time away is off the scale.
  Every part sits at its own time and length on it, with no gap added: a slice too short to see is
  drawn 3px wide over what follows it, which still starts at its own time.
- **A round's jobs are lanes** at their own start and stop, shards beside Checks and Test, each job's lead dotted before it. Jobs that overlapped sit in rows (the busiest on the strip's line, then above, then below); one that began where another ended is in its row after it. Stacked rows are parted by a hairline in the page's background. A failed job is ringed and a re-run hatched; hover a lane, or pick it on the zoomed strip, for its start and stop to the second (Belgian time). A round with `lanes: null` is the block split by what held it, and its hover says its lanes are not recorded.
- **A round is a CI Round**, named on the strip by the width it has on screen: "CI Round 1", then
  "CI 1", then only its red or fluke mark (a round with neither shows no name). Its detail reads
  "CI Round 1 · …", and the legend defines the term.
- **Click a strip to zoom it**: the same pull request, uncut, on its own scale with a clock-time
  axis (Belgian time). Click the axis, or an empty row above or below the line, to close it. A closed
  strip has no axis, and under it only its summary line and the notes.
- **On a zoomed strip, click an element to read it in the box under the axis**: a coding, fixing,
  waiting or away stretch, a local review, test run or browser pass, a CI job or its lead, or a
  round's name. Hover outlines the element under the pointer and nothing around it, and the
  browser's tooltip stays. A pull request holds one pick, kept while its zoom is closed; until
  something is picked the box holds the summary line. A round's detail is its line, including what
  held it in order, with every job's line beneath it; a job's is its own line and the round it ran
  in, without what held the round, which under one job would read as that job's story.
- **All of it is CSS only**: the strip is the label of a checkbox, each element a radio laid over it
  (so Tab and the arrow keys reach it), the names container queries. A detail several controls
  pick, a round's background and both its names, is written once and shown by each of them.
- **Overlapping local work keeps the longest piece on the strip's line**; the rest stack above it,
  then below, then further out. Where none of them runs on the line, it shows the coding or fixing.
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
