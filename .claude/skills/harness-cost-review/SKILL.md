---
name: harness-cost-review
description: Cockpit's process for periodically checking whether a required CI check, agent review, or branch-protection gate is still earning its cost - cross-referencing .github/branch-protection.json's required checks against tools/ci-stability's pass-rate and duration data, and sampling agent-review verdicts for warnings that fire without signal - then filing one issue per candidate for a person to decide. Never a report, and never on an impression without a sampled window behind it. Hands each candidate through scoping and github-issue; never edits workflows, branch-protection, or review prompts itself.
---

# Is the harness still earning its cost

A check that blocks constantly is visible from inside a single pull request. A check that almost never blocks, or has quietly gotten slow, is not — it looks the same as a healthy gate from any one pull request, and only counted across many does the pattern show. This finds that pattern by counting, the same discipline [periodic-review](../periodic-review/SKILL.md) applies to recurring mistakes, and files one issue per candidate rather than a report.

**This never removes or weakens anything itself.** It files a candidate, with the evidence that produced it, for a person to decide — the harness stays exactly as strict until someone acts on the issue.

## Process

### 1. Inventory the required checks

```bash
cat .github/branch-protection.json
```

Read `required_status_checks.contexts` — that list is the whole scope; nothing not on it is a candidate here, however slow or noisy. Cross-reference each context against `.github/workflows/*.yml` to find what produces it: a required context is a job's `name:` (or its job id, when the job declares none), not the workflow's own top-level `name:`. `CodeQL (javascript-typescript)` and `CodeQL (actions)` are one matrix job's two legs; the third required context, bare `CodeQL`, is posted by GitHub Advanced Security itself rather than by any workflow run in this repository, so it carries no data in step 2 — note it and move on.

Split what's left into two kinds, because they need different evidence:

- **Mechanical** — Typecheck, Lint, Test, E2E (F3), Build, Scripts, the two CodeQL legs. Pass or fail is a deterministic fact about the code.
- **Judgement** — `claude-review`, Security review. Pass or fail is a model's call, and a required check here can be "working" at a low hit rate the way a smoke detector is — rarely firing is not by itself evidence of nothing to fire on.

### 2. Pull pass-rate and duration for the mechanical checks

```bash
pnpm --filter @cockpit/ci-stability model -- --days 30 --max-runs 2500 --out /tmp/harness-cost-model.json
```

Raise `--max-runs` past its default of 800: measured against this repository on 10 September 2026, the default budget stopped barely 12 days back, well short of the requested 30 — merge volume alone outruns it. Check `coverage.partial` and each `windows[].partial` in the written model before reading a number out of it; a partial window's own `actualDays` is what it actually covers, not what was asked for. Raise `--max-runs` only as far as clearing 30 days needs: fetching job detail costs one request per non-skipped run, and an authenticated token is capped at 1,000 requests an hour per repository (`tools/ci-stability/src/github.js`'s own header comment) — a budget large enough for 90 days would spend that allowance before finishing.

The model's `windows[].workflows[].jobs[]` gives each job's `tally.rate` (pass rate over what completed), `tally.completed` (the sample size), and `durations.median`/`durations.p90` in milliseconds — read `tools/ci-stability/README.md`'s "What the numbers mean" for what a rate does and doesn't count (cancelled runs excluded, a rate is null under zero completions). Match each required context from step 1 to its job row by name.

A rate under a small sample is not evidence: **require at least 20 completed runs in the window before reading a rate at all** — ci-stability itself declines to publish one under zero, and a handful above that is barely better. A required check clears 20 easily inside even the truncated 12-day window measured above; one that doesn't is too new to have an opinion about yet.

### 3. Sample the judgement checks for warnings that carry no signal

Pass/fail is the wrong instrument here — a low hit rate can be correct. What "Make the security review's warnings mean something, or drop them" (PR 323) found instead was a *sub-signal inside a passing check* that fired on almost every run regardless of what the run was: 7 of 8 sampled pull requests carried a turn-count warning under a clean verdict, with the turn count itself (4–9) uncorrelated with diff size — a 448-line, 5-file change took 4 turns, a 556-line, 25-file one took 9. That is what this step looks for again, generalized past that one warning.

Sample the last 8–10 pull requests the judgement check actually ran on (skip drafts and forks — the workflows skip those too):

```bash
gh pr list --state merged --search "sort:created-desc" --json number,title,url,mergedAt,additions,deletions,changedFiles -L 10
```

For each, read the gate's own sticky comment (author `github-actions[bot]`, security review) and the review's own summary/inline comments (code review) with the same GraphQL query [periodic-review](../periodic-review/SKILL.md) step 2 uses:

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100){ nodes{ comments(first:20){ nodes{ body path } } } }
        comments(first:100){ nodes{ body } }
        reviews(first:20){ nodes{ body } }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F number=<n>
```

Tabulate every distinct warning or recurring finding-type against the sampled pull requests' `additions`/`deletions`/`changedFiles` and against the verdict it appeared under. A turn count, a token or cost figure, and any other run-level number are not in that comment — they were dropped from it by PR 323 for exactly this reason — so a candidate that needs one falls back to the run log: `gh run view <run-id> --log --job <job-id>`, the same way PR 323 pulled real denial text from two runs by hand. Treat that as a deeper, optional step, not the default path.

**A warning is a candidate only if it fires on at least three-quarters of a sample of at least eight runs, under a verdict that didn't block, with no visible correlation to the size or shape of the change.** That is the 7-of-8 bar PR 323 itself cleared, stated as a threshold rather than a one-off count.

### 4. Flag only what clears its bar

- **Mechanical, rarely blocks**: pass rate ≥ 98% over a window with ≥ 20 completed runs (step 2). Note the rate, the completed count, and the window.
- **Mechanical, grown expensive**: `durations.p90` (or median) at least 50% higher in the 7-day window than the 30-day window, both non-partial with ≥ 20 completed runs, and the 7-day p90 itself at least 3 minutes — a job that doubled from 10 seconds to 20 is not a finding. Note both figures and both sample sizes; skip this bar entirely for a check where either window came back partial (step 2) rather than filing a trend off a window that doesn't actually cover what it claims to.
- **Judgement, signal-free warning**: the step-3 bar. Note the fraction, the sample, and what was checked for correlation and found none.

A check can clear more than one bar; file it once, noting every bar it cleared.

### 5. Check it isn't already tracked

```bash
gh label create harness-cost-review --color 5319e7 --force
gh issue list --label harness-cost-review --state open --json number,title,body -L 100
```

Matching on body, not title, for the same reason [periodic-review](../periodic-review/SKILL.md) step 4 does: a candidate that keeps clearing the bar because nobody has acted on it yet is not a new finding. Skip filing if one already names the same check and the same bar.

### 6. Size and file each candidate

Each candidate is already one unit for [scoping](../scoping/SKILL.md)'s sizing step. Failure modes: usually none — the fix this issue asks for is a person tightening, narrowing, or dropping a check, not a state change this skill makes. A statement list is rarely the right shape for a decision like "is this check worth its cost"; where scoping's own step would produce "None," say that.

Hand it to [github-issue](../github-issue/SKILL.md) for the body. **Problem** and **What to build** carry the evidence — the check's name, which bar it cleared, the numbers, the window and sample size — and name it as a candidate to tighten, narrow, or drop, not a decision already made: the person who reads it still chooses whether the cost is worth it. Apply the `harness-cost-review` label after filing.

## Output

Filed issues, one per required check that cleared a bar in step 4 and wasn't already tracked, each carrying the numbers that produced it. Nothing about branch protection, a workflow file, or a review prompt is edited by this skill itself.

## Cadence

Run this monthly, or after a required check is added or changed enough to want a fresh baseline — not on a schedule as tight as periodic-review's few weeks. The evidence here is a rate and a duration trend, and both move slowly: a 30-day pass rate barely shifts week to week, so running this weekly would mostly re-read the same window and find nothing new. A GitHub Actions cron (`.claude/skills/schedule` or `CronCreate`) fits better than a per-push or per-merge trigger, since nothing about a single pull request should make this run.
