---
name: harness-cost-review
description: Cockpit's process for periodically checking whether a required CI check, agent review, or branch-protection gate is still earning its cost - sampling recent pull requests for how often each required check actually blocked one and what tools/ci-stability says about its duration, and reading agent-review verdicts for warnings that fire without signal - then filing one issue per candidate for a person to decide. Never a report, and never on an impression without a sampled window behind it. Hands each candidate through scoping and github-issue; never edits workflows, branch-protection, or review prompts itself.
---

# Is the harness still earning its cost

A check that blocks constantly is visible from inside a single pull request. A check that almost never blocks, or has quietly gotten slow, is not — it looks the same as a healthy gate from any one pull request, and only counted across many does the pattern show. This finds that pattern by counting, the same discipline [periodic-review](../periodic-review/SKILL.md) applies to recurring mistakes, and files one issue per candidate rather than a report.

**This never removes or weakens anything itself.** It files a candidate, with the evidence that produced it, for a person to decide — the harness stays exactly as strict until someone acts on the issue.

## Process

### 1. Inventory the required checks

```bash
cat .github/branch-protection.json
```

Read `required_status_checks.contexts` — that list is the whole scope; nothing not on it is a candidate here, however slow or noisy. Cross-reference each context against `.github/workflows/*.yml` to find what produces it: a required context is a job's `name:` (or its job id, when the job declares none), not the workflow's own top-level `name:`. `CodeQL (javascript-typescript)` and `CodeQL (actions)` are one matrix job's two legs; the third required context, bare `CodeQL`, is posted by GitHub Advanced Security itself rather than by any workflow run in this repository, so it carries no data in the steps below — note it and move on.

Split what's left into two kinds, because they need different evidence:

- **Mechanical** — Typecheck, Lint, Test, E2E (F3), Build, Scripts, the two CodeQL legs. Pass or fail is a deterministic fact about the code.
- **Judgement** — `claude-review`, Security review. Pass or fail is a model's call, and a required check here can be "working" at a low hit rate the way a smoke detector is — rarely firing is not by itself evidence of nothing to fire on.

### 2. Sample the pull requests both tracks read from

Both tracks below read off the same sample, so pull it once:

```bash
gh pr list --state merged --search "sort:created-desc" --json number,title,url,mergedAt,additions,deletions,changedFiles,commits -L 100 \
  | jq 'sort_by(.mergedAt) | reverse | .[:25]'
```

`--search` sorts by creation, not merge, and GitHub's PR search has no qualifier that sorts by merge date — the same reason [periodic-review](../periodic-review/SKILL.md) step 2 fetches a larger creation-sorted slice and re-sorts it before sampling, which this pipes through `jq` to do in one step. 25 is the sample size "Fail on the writing rules a script can decide, instead of finding them in review" (issue 278) itself drew from; each pull request in it usually carries several commits, so step 3's check-run tally comfortably clears step 6's 20-attempt floor even once a few are dropped for being drafts or forks, which the judgement checks skip outright. The re-sort is by `mergedAt`, not creation: a pull request opened early and merged late is the kind with the most pushed commits and the most review to read.

**A merged pull request's final head commit already passed every required check** — branch protection would not have allowed the merge otherwise — so reading only that commit's check-runs measures nothing but successes, the same tautology a bare `main`-branch pass rate has: `main`'s own history is exactly the population of code that already cleared these checks, so a rate read off it says how green `main` stays, not how often a check actually stopped anything. Every *earlier* commit pushed to the pull request carries its own check-run history, and a push that failed and was then fixed is exactly the evidence "did this check ever block" needs:

```bash
gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | {name, conclusion, started_at, completed_at}'
```

Run it for every commit `oid` in each sampled pull request's `commits` list, not just the head. A commit can carry more than one check-run under the same name — a superseded rerun shows as `skipped` then a real conclusion, a flaky one as `failure` then `success` — so read every row, not only the last.

For the judgement checks, also pull the review content with the same GraphQL query [periodic-review](../periodic-review/SKILL.md) step 2 uses, extended with the `author` field this skill needs to tell the gate's own comment apart from a human quoting the same text:

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100){ nodes{ comments(first:20){ nodes{ body path author{ login } } } } }
        comments(first:100){ nodes{ body author{ login } } }
        reviews(first:20){ nodes{ body author{ login } } }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F number=<n>
```

### 3. Tally how often each mechanical check actually blocked

From step 2's check-run rows, classify each one the way `tools/ci-stability` itself does (`src/model.js`'s `CONCLUSIONS` map): `success` is a pass, `failure`/`timed_out`/`startup_failure` is a fail, and `skipped`/`cancelled` are not an attempt at all — a superseded rerun is not evidence either way. Tally pass and fail per required context, across every commit in the sample.

### 4. Pull duration for the mechanical checks from ci-stability

```bash
pnpm --filter @cockpit/ci-stability model -- --days 30 --max-runs 2500 --out /tmp/harness-cost-model.json
```

Raise `--max-runs` past its default of 800: measured against this repository on 10 September 2026, the default budget stopped barely 12 days back, well short of the requested 30 — merge volume alone outruns it. Check `coverage.partial` and each `windows[].partial` in the written model before reading a number out of it; a partial window's own `actualDays` is what it actually covers, not what was asked for. Raise `--max-runs` only as far as clearing 30 days needs: fetching job detail costs one request per non-skipped run, and an authenticated token is capped at 1,000 requests an hour per repository (`tools/ci-stability/src/github.js`'s own header comment) — a budget large enough for 90 days would spend that allowance before finishing.

The model's `windows[].workflows[].jobs[].durations` gives `median`/`p90` in milliseconds per job, over the runs `main` actually saw — read `tools/ci-stability/README.md`'s "What the numbers mean" for what it does and doesn't count (cancelled runs excluded). This is duration only: step 3 is where a check's block rate comes from now, not this model's own `tally.rate`, for the reason step 2 gives.

### 5. Sample the judgement checks for warnings that carry no signal

Pass/fail is the wrong instrument here — a low hit rate can be correct. What "Make the security review's warnings mean something, or drop them" (PR 323) found instead was a *sub-signal inside a passing check* that fired on almost every run regardless of what the run was: 7 of 8 sampled pull requests carried a turn-count warning under a clean verdict, with the turn count itself (4–9) uncorrelated with diff size — a 448-line, 5-file change took 4 turns, a 556-line, 25-file one took 9. That is what this step looks for again, generalized past that one warning, over step 2's GraphQL pull.

From each sampled pull request, keep only the comments and review bodies whose `author.login` is the review's own bot (`github-actions[bot]` for the security-review gate's sticky comment, `claude[bot]` for both reviews' own posts) — a human quoting the same warning back is not a second occurrence of it. Tabulate every distinct warning or recurring finding-type against the sampled pull requests' `additions`/`deletions`/`changedFiles` and the verdict it appeared under.

A turn count, a token or cost figure, and any other run-level number are not in that comment — they were dropped from it by PR 323 for exactly this reason — so a candidate that needs one falls back to the run log: `gh run view <run-id> --log --job <job-id>`, the same way PR 323 pulled real denial text from two runs by hand. Treat that as a deeper, optional step, not the default path.

**A warning is a candidate only if it fires on at least three-quarters of a sample of at least eight runs, under a verdict that didn't block, with no visible correlation to the size or shape of the change.** That is the 7-of-8 bar PR 323 itself cleared, stated as a threshold rather than a one-off count.

### 6. Flag only what clears its bar

- **Mechanical, rarely blocks**: step 3's tally shows ≥ 20 attempts (skipped/cancelled excluded) for the check, and it failed on ≤ 2% of them — or never. Note the fail count, the attempt count, and the pull-request sample it came from.
- **Mechanical, grown expensive**: `durations.median` at least 50% higher in the 7-day window than the 30-day window (step 4), both non-partial with ≥ 20 completed runs, and the 7-day median itself at least 3 minutes — a job that doubled from 10 seconds to 20 is not a finding. Median, not p90, decides this: the 7-day window is a subset of the 30-day one, so a regression only needs to fill about a tenth of the 30-day window before its p90 already equals the 7-day figure, making the ratio read 1.0 for a real, ongoing doubling once it is a few days old. A regression has to fill more than half the 30-day window before doing the same thing to the median, which is why the median survives as a signal for far longer — p90 is still worth reporting alongside it, but only as a second number, not what the bar is read from. Skip this bar entirely for a check where either window came back partial (step 4) rather than filing a trend off a window that doesn't actually cover what it claims to.
- **Judgement, signal-free warning**: the step-5 bar. Note the fraction, the sample, and what was checked for correlation and found none.

A check can clear more than one bar; file it once, noting every bar it cleared.

### 7. Check it isn't already tracked

```bash
gh label create harness-cost-review --color 5319e7 --force
gh issue list --label harness-cost-review --state all --json number,title,body,state -L 100
```

Matching on body, not title, for the same reason [periodic-review](../periodic-review/SKILL.md) step 4 does. `--state all`, not just `open`: an open one is unfixed and still clearing the bar for that reason alone, exactly as periodic-review reads it — but a *closed* `harness-cost-review` issue is not evidence the mistake stopped recurring the way a closed `periodic-review` issue is, because closing this kind of issue often means a person read the evidence and decided the check is worth its cost exactly as it stands, not that anything about the check changed. Its rate or duration doesn't move just because the issue did. Skip filing against either state unless the fresh numbers have moved meaningfully past what the earlier issue recorded — the same order of movement step 6's own bars already ask for, applied against that issue's numbers instead of an absolute floor — and when they have, name in the new issue what the earlier one decided and what changed since.

### 8. Size and file each candidate

Each candidate is already one unit for [scoping](../scoping/SKILL.md)'s sizing step. Failure modes: usually none — the fix this issue asks for is a person tightening, narrowing, or dropping a check, not a state change this skill makes. A statement list is rarely the right shape for a decision like "is this check worth its cost"; where scoping's own step would produce "None," say that.

Hand it to [github-issue](../github-issue/SKILL.md) for the body. **Problem** and **What to build** carry the evidence — the check's name, which bar it cleared, the numbers, the window and sample size — and name it as a candidate to tighten, narrow, or drop, not a decision already made: the person who reads it still chooses whether the cost is worth it. Apply the `harness-cost-review` label after filing.

## Output

Filed issues, one per required check that cleared a bar in step 6 and wasn't already tracked, each carrying the numbers that produced it.

## Cadence

Run this monthly, or after a required check is added or changed enough to want a fresh baseline — not on a schedule as tight as periodic-review's few weeks. The evidence here is a block rate and a duration trend, and both move slowly: neither shifts much week to week, so running this weekly would mostly re-read the same sample and find nothing new. A scheduled cloud agent set up through the `schedule` skill, or a repository cron added with `CronCreate`, fits better than a per-push or per-merge trigger, since nothing about a single pull request should make this run.
