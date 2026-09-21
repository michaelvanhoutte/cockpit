# Lead time

Answers, without querying the API by hand: **how long does a change spend being written
against waiting on the harness, how many rounds does it take, and which check holds each
round up.** Reads the pull request and Actions APIs and each pull request's session record
("Record what a session did, on the pull request it opens", issue 514), and writes the model as
JSON. Keeps no state — GitHub already stores this history, so every run re-derives it.

The page that draws the model is "Draw the lead-time page from the model" (issue 389); running
it nightly is "Run the lead-time report nightly, and publish it beside the other two" (issue 515).

## Running it

```bash
pnpm lead-time            # from the repo root — writes tools/lead-time/out/model.json
```

```bash
cd tools/lead-time
node src/cli.js                       # over 7 and 14 days
node src/cli.js --windows 1,7         # different windows
node src/cli.js --max-pulls 40        # stop at 40 pull requests, and report the period it reached
node src/cli.js --repo owner/name     # a different repository
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
- **Ready or draft**: a round in which the code review or the security review ran is `ready`,
  since a draft skips both. Their runs and total time are on each pull request under `reviews`.
- **A conclusion it does not know is neither a pass nor a fail**, and is named in the round's
  `unrecognised`.
- **Time nobody wrote down reads as not recorded, never zero.** A pull request with no record
  starts at its first commit and says so in `notes`; a record missing one phase is read for the
  rest (`notRecorded` lists what it lacks); a record whose start is after the first commit is
  ignored for its start. `localReviews` is `null` where no review was marked start and end.
- **Every figure carries its counts**: `count` is the items behind it (rounds, gaps) and `pulls`
  the pull requests they came from. A window with nothing in it reads `null`, not zero, and
  `pulls.withoutRecord` says how many pull requests the record-based figures left out. A pull
  request closed without merging is in no figure.

Over each window the model gives the median and p90 of every part; `pulls` in the model is the
per-pull-request detail behind them.

## How a model gets built

```
collect(repo)  →  buildModel(...)  →  out/model.json
  (src/github.js)   (src/model.js)
```

`github.js` is the only file that does I/O and `model.js` the only one that computes;
`cli.js` wires them. Sessions' record format is `scripts/lib/session-record.mjs`'s, imported
rather than copied, so the two cannot drift.

**Request cost is what shapes `github.js`**, and its header comment is where that is worked out:
about 5 to 6 requests per pull request against the 1,000 an hour a `GITHUB_TOKEN` allows.
`--max-pulls` stops rather than spending it, and the model's `coverage` reports the period it
actually reached — as does a listing that ends before the window does. A pull request whose
commits or check runs cannot be read is named in `coverage.failed` and left out; a spent rate
limit fails the run, since what comes after it would be missing for the same reason.

## Tests

The model and the argument parser are `tests/unit/`; the fetcher, driven through a stubbed
`fetch`, is `tests/integration/`. Nothing reaches the network, so neither needs a token.
