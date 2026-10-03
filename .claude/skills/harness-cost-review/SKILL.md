---
name: harness-cost-review
description: Cockpit's process for periodically checking whether the harness - CI, local reviews and the session's own waiting on them - is too slow or too expensive for the development it gates, and why - reading the lead-time, selection and CI stability models and pnpm cost:issue, applying one bar per cause (harness outweighing coding, unselective tests, slices too small, avoidable rounds, repeating failures, token cost, queue time, serial jobs, cancelled runs, setup overhead, a job grown slower), then filing one issue per cause for a person to decide. Never counts anything a tool already measures, never a report, and never on an impression without a sampled window behind it. Hands each candidate through scoping, engineering-plan and github-issue; never edits workflows, branch-protection, or review prompts itself.
---

# Is the harness too heavy for the development

The harness is everything a change waits on after it is written: CI, the local reviews, and the tokens a session spends waiting and fixing. It is too heavy when it costs more than the development it gates, and each cause needs a different fix — so this names the cause, not only the symptom, and files one issue per cause for a person to decide. **It never removes or weakens a check itself**, and **a check that rarely fails is never a candidate**: it is guarding code that is rarely broken.

**Tools measure; this skill reads and decides.** Every number below comes from a tool's model. Where a bar needs a number no tool has yet, the bar names the issue that adds it: skip that bar and say so, never count it by hand.

## Process

### 1. Build the models

| Model | Command | Gives |
|---|---|---|
| Lead time | `node tools/lead-time/src/cli.js --json --out <scratch>/lead.json` | per merged pull request: coding against harness (`balance`), rounds, red rounds, flukes, which check held each round, local reviews, size |
| Selection | `node tools/selection/src/cli.js --json --out <scratch>/sel.json` | paths forcing a full run, tests selected on nearly every pull request, misses |
| CI stability | `node tools/ci-stability/src/cli.js --json --days 30 --max-runs 2500 --out <scratch>/ci.json` | job durations on `main` per window |
| Token cost | `pnpm cost:issue --since <window start> --json` | per issue: tokens, API-equivalent cost, subagents, review passes by level |

Each tool's README says what its figures count and leave out; read it before quoting a number from it. Check each model's `coverage.partial` and every window's `partial` first, and read a partial window by its `actualDays`. Selection downloads run artifacts and token cost reads Claude Code's own logs on the machine, so both run only on a developer's machine; elsewhere skip their bars and say so. "Publish each nightly report's model beside its page" (issue 670) will let all three CI models be read from the site instead.

### 2. Apply one bar per cause

Read the 14-day window unless a bar says otherwise. A bar needs at least 20 merged pull requests in its window, or the count it names. These thresholds are starting values: when one fires on noise or misses a real cause, change it here.

| Cause | Bar | Read from |
|---|---|---|
| **Harness outweighs coding** | `balance.ratio.median` > 1, or more than half the `balance.dots` above 1, over ≥ 20 recorded pull requests | lead time |
| **Not selective enough** | one `forcedFull` rule or path forces a full run on ≥ 25% of the pull requests that ran; or a test file selected on ≥ 80% of the pull requests that could have skipped it, over ≥ 10 | selection |
| **Slices too small** | pull requests under 100 lines changed (`size.additions + size.deletions`) with a median `balance.ratio` ≥ 2, over ≥ 8 of them: the fixed cost of a round outweighs the change | lead time |
| **Avoidable rounds** | `rounds.perPull.median` ≥ 2; or red rounds whose `failed` includes `Checks` (lint, typecheck, build — all runnable before a push) on ≥ 10% of rounds | lead time |
| **Repeating failures** | a check with flukes on ≥ 3 pull requests and ≥ 5% of its rounds; or one test file failing on ≥ 3 pull requests, once "Name the failing tests and step behind every red and fluke round in the lead-time model" (issue 666) lands | lead time |
| **Token cost** | an issue costing ≥ 3× the window's median cost per 100 lines changed, where ≥ 2 such issues share a cause; a `/code-review` or `/security-review` level above what CLAUDE.md's review table gives the change, on ≥ 2 issues; subagents ≥ 50% of an issue's cost on ≥ 2 issues; or cost after `pushed` ≥ 40% of an issue's total on ≥ 2 issues, once "Split an issue's token cost by session phase in pnpm cost:issue" (issue 669) lands | token cost, joined to lead time by the pull request that closes the issue |
| **Queue time** | median queue time ≥ 2 minutes for any required check, once "Split queue time from run time, and count cancelled runs, in the lead-time model" (issue 667) lands | lead time |
| **Serial jobs** | a job that others `needs:` in `.github/workflows/ci.yml` takes ≥ 25% of the critical path: its median plus the slowest median of the jobs waiting on it | CI stability, 7-day window |
| **Cancelled runs** | cancelled runner minutes ≥ 10% of all harness minutes, once issue 667 lands | lead time |
| **Setup overhead** | setup steps (install, browser install, build) ≥ 25% of a job's median, once "Report step durations per job in the CI stability model" (issue 668) lands | CI stability |
| **A job grown slower** | a required job's 7-day median ≥ 50% above its 30-day median and ≥ 3 minutes, both windows non-partial with ≥ 20 runs. Median, not p90: the 7-day window is inside the 30-day one, so a regression lifts the 30-day p90 to match within days and the ratio reads flat | CI stability |

For a cause that clears its bar, note the numbers, the window, the counts behind them and the pull requests or issues they came from. Where several causes clear on the same pull requests, say which explains the most: small slices and avoidable rounds both inflate the balance, and fixing the wrong one changes nothing.

**Optional review nits that start a push** have no model. Where avoidable rounds clear, read the review threads of the pull requests with the most rounds (`gh api repos/<owner>/<repo>/pulls/<n>/comments`) and count rounds pushed only for a finding the review marked optional.

### 3. Check it isn't already tracked

```bash
gh label create harness-cost-review --color 5319e7 --force
gh issue list --label harness-cost-review --state all --json number,title,body,state -L 100
```

Match on the body, not the title, as [periodic-review](../periodic-review/SKILL.md) does. A closed issue often means a person read the evidence and kept the harness as it was, so skip a cause tracked in either state unless its numbers have moved past what that issue recorded by as much as its bar asks; when they have, name what the earlier issue decided and what changed since.

### 4. File one issue per cause

Each cause is one unit for [engineering-plan](../engineering-plan/SKILL.md)'s sizing. Hand it to [github-issue](../github-issue/SKILL.md): **Problem** carries the cause, the bar it cleared and the numbers with their counts; **What to build** names the candidate fixes for that cause — a narrower selection rule, bigger slices, a pre-push step, a robust test, caching, a parallel job — as candidates, not a decision. Apply the `harness-cost-review` label after filing.

## Output

Filed issues, one per cause that cleared its bar and was not already tracked, each carrying the numbers behind it — and a line naming the bars skipped and why.

## Cadence

Monthly, or after the harness changes enough to want a fresh baseline. Balance, selection and cost move slowly, so a weekly run mostly re-reads the same pull requests.
