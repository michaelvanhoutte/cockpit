# Test selection

Answers, without reading the artifacts of one hundred runs by hand: **is test
selection working.** Reads what every Test job selected and why — the record
["Record what CI's Test job selected, and why, on every run"](../../scripts/lib/test-record.mjs)
writes and uploads on each run — across merged pull requests, and draws one
HTML page: whether a skipped test later failed on `main`, which paths keep
forcing a full run, which tests are selected on nearly every pull request, and
each pull request's own selection in full. Keeps no state — the record already
lives in every run's own artifact; this only reads it across many.

## Reading it without running it

The `Selection` job of [`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml)
builds this page once a night, for the request-cost reason the
[lead-time page](../lead-time/README.md) gives for its own nightly job; a dispatch of that
workflow by hand covers a missed night. `Publish` in `ci.yml` takes the artifact the newest
`main` run of it made and serves it at
**<https://michaelvanhoutte.github.io/cockpit/selection/>**, alongside the test explorer, the
[CI stability page](../ci-stability/README.md) and the lead-time page — last night's copy,
carried forward until the next one lands, and absent only from this one corner of the site
when the job itself fails.

## Running it

```bash
pnpm selection            # from the repo root — writes tools/selection/out/index.html
pnpm --filter @cockpit/selection model   # the model instead, at out/model.json
```

```bash
cd tools/selection
node src/cli.js                       # over the last 14 days
node src/cli.js --windows 1,7         # different windows for "Is selection working?"
node src/cli.js --max-pulls 40        # stop at 40 merged pull requests
node src/cli.js --repo owner/name     # a different repository
node src/cli.js --help
```

`resolveToken` in `src/cli.js` reads `GITHUB_TOKEN`, then `GH_TOKEN`, then falls back to
`gh auth token` for a machine that already has `gh` signed in. Run it with none of those and
GitHub caps the unauthenticated caller at 60 requests an hour, which a window's worth of pull
requests will exhaust before it finishes.

## What the model says

**A pull request is one of three things**: `ran` (its Test job uploaded a
record — the ordinary case), `docs-only` (no record, and its diff is
documentation only, so ci.yml's own gate never started the Test job) or
`no-record` (no record and no such excuse — the artifact expired past its
retention, or the job failed to upload one). Only a `no-record` pull request
is left out of the figures below in both directions: there is no way to tell
what it would have done.

- **A miss is a test file that failed on `main`'s run of a merge, where the
  merged pull request's own last run did not run it** — read from the record
  each side's own Test job wrote, never a second guess at what should have
  run. A pull request explains a miss by having run the file (whatever the
  outcome) or by having run its whole package in full; a `docs-only` pull
  request explains none of `main`'s failures, so every one is a miss for it,
  tagged `docs only`.
- **What forced a full run** counts a pull request once per distinct rule and
  path, even where several of its packages were forced by the same one — a
  lockfile change forces every package identically, and that is one reason,
  not many.
- **Tests selected most often** counts a pull request toward a file's
  denominator only where the file's own package ran in `changed` mode at all
  — the pull requests that had the *opportunity* to select it — apart from
  the pull requests that ran it because their package was full, tracked on
  the side. Ties in the most common import chain keep whichever was seen
  first; the issue that scoped this report calls that "either is correct".
- **"Is selection working?" is per window (7 and 14 days by default) and says
  "none" rather than inventing a number**: a window with no pull requests, or
  where selection never ran at all, reads "none" for the figures that would
  otherwise be a zero nobody earned.

## How a page gets built

```
collect(repo)  →  buildModel(...)  →  renderHtml(model)  →  out/index.html
  (src/github.js)   (src/model.js)      (src/render/)         (out/model.json with --json)
```

`github.js` is the only file that does I/O and `model.js` the only one that
computes; `render/` draws what it is handed. `src/zip.js` is just enough of
the zip format to read the one file (`record.json`) out of the archive
GitHub's artifact download endpoint hands back — nothing else in this
repository reads a zip, so nothing bigger earns its dependency for it.

**Any failure to read one pull request's data fails the whole run**, unlike
the other three reports here: this one exists to find gaps in selection, so a
pull request quietly dropped from it would be a gap the report itself
introduced. Only a genuinely absent record — expired, or a documentation-only
pull request whose Test job never started — is not a failure.

**Request cost**: up to two workflow-run lookups, two job lists, two artifact
lists and two zip downloads per pull request, plus one changed-file listing
where a record is missing — about ten requests each, so a fourteen-day window
of a few dozen merges stays well inside the thousand `GITHUB_TOKEN` allows an
hour. `--max-pulls` stops rather than spending it.

## Tests

`pnpm test` from the repo root, or `pnpm --filter @cockpit/selection test`, runs both tiers:
`src/zip.js`, `src/model.js` and the argument parser under `tests/unit/`, and `src/github.js`'s
whole fetch pipeline — a stubbed `fetch` standing in for the API and the artifact zip alike —
under `tests/integration/`. Neither reaches a socket, so the suite asks nothing of the
environment it runs in.
