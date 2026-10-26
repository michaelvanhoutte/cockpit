---
name: harness-cost-review
description: Cockpit's process for periodically checking whether the harness - CI, local reviews and the session's own waiting on them - is too slow or too expensive for the development it gates, and why - reading the cycle-time, selection and CI stability models from the published site and pnpm cost:issue, applying one bar per cause (harness outweighing coding, unselective tests, tests that skip too much, slices too small, avoidable rounds, repeating failures, token cost, queue time, serial jobs, cancelled runs, setup overhead, a job grown slower, a report not published), then filing one issue per cause for a person to decide. Never counts anything a tool already measures, never a report, and never on an impression without a sampled window behind it. Hands each candidate through scoping, engineering-plan and github-issue; never edits workflows, branch-protection, or review prompts itself.
---

# Is the harness too heavy for the development

The harness is everything a change waits on after it is written: CI, the local reviews, and the tokens a session spends waiting and fixing. It is too heavy when it costs more than the development it gates, and each cause needs a different fix — so this names the cause, not only the symptom, and files one issue per cause for a person to decide. **It never removes or weakens a check itself**, and **a check that rarely fails is never a candidate**: it is guarding code that is rarely broken.

**Tools measure; this skill reads and decides.** Every number below comes from a tool's model. Where a bar needs a number no tool has yet, the bar names the issue that adds it: skip that bar and say so, never count it by hand.

## Process

### 1. Read the models

Each report's model is read from the published site with `curl -fsSL <url> -o <scratch>/<name>.json`, never built here: the page, the bars and the open alarms all read that file, so a copy built from another commit would disagree with them.

| Model | Read from | Gives |
|---|---|---|
| Cycle time | `https://michaelvanhoutte.github.io/cockpit/cycle-time/model.json` | per merged pull request: coding against harness (`balance`), rounds, red rounds, flukes, which check held each round, local reviews, size; per window: failing tests and steps (`failures`), queue time per check (`queue`), cancelled runner minutes (`cancelled`) |
| Selection | `https://michaelvanhoutte.github.io/cockpit/selection/model.json` | `bars.items`: each headline figure with its `verdict`; `forcedFullRules`: a row per rule above its paths; misses |
| CI stability | `https://michaelvanhoutte.github.io/cockpit/stability/model.json` | job and step durations on `main` per window |

These tools run on this machine, since they read Claude Code's own logs:

| Tool | Command | Gives |
|---|---|---|
| Token cost | `pnpm cost:issue --since <window start> --json` | per issue: tokens, API-equivalent cost, subagents, review passes by level; tokens and cost also split by session phase (`phases`) |
| One run | `pnpm cost:issue --run <issue> [--json]` | a row per pull request of an issue and its children, then a total: start and end, coding time, each review's time with reported, fixed and declined, each CI wait's time and outcome, token cost; "not recorded" where a mark was skipped |

Each tool's README says what its figures count and leave out; read it before quoting a number from it. Check each model's `coverage.partial` and every window's `partial` first, and read a partial window by its `actualDays`.

**A model that is missing from the site, whose `generatedAt` is more than two days old, or that lacks a field a bar reads is itself a finding** (*Report not published* below), never a line saying it was not read: a report nobody can read is a report nobody is watching. Skip only the bars that model feeds. Token cost has no model on the site; on a machine without Claude Code's logs, skip its bar and say so.

### 2. Apply one bar per cause

Read the 14-day window unless a bar says otherwise. A bar needs at least 20 merged pull requests in its window, or the count it names; *Report not published* needs none. These thresholds are starting values: when one fires on noise or misses a real cause, change it here. The selection bars' numbers are the exception, since the model and its page read them from `BARS` in `tools/selection/src/model.js`: change them there.

| Cause | Bar | Read from |
|---|---|---|
| **Harness outweighs coding** | `balance.ratio.median` > 1, or more than half the `balance.dots` above 1, over ≥ 20 recorded pull requests | cycle time |
| **Not selective enough** | a `bars.items` entry with `id` `e2e-forced-full` or `test-forced-full` and `verdict` `crossed`: a job forced to run everything on ≥ 25% of the pull requests that ran it. Read the verdict, never recount: `cause` names the rule behind a forced-full bar and its row in `forcedFullRules` the paths; `unread` (`unread` says whether the window or the figure) is no finding | selection |
| **Tests skip too much** | the `bars.items` entry `misses` with `verdict` `crossed`: any test that failed on `main` where the pull request that merged did not run it | selection |
| **Slices too small** | pull requests under 100 lines changed (`size.additions + size.deletions`) with a median `balance.ratio` ≥ 2, over ≥ 8 of them: the fixed cost of a round outweighs the change | cycle time |
| **Avoidable rounds** | `rounds.perPull.median` ≥ 2; or red rounds whose `failed` includes `Checks` (lint, typecheck, build — all runnable before a push) on ≥ 10% of rounds | cycle time |
| **Repeating failures** | a check with flukes on ≥ 3 pull requests and ≥ 5% of its rounds; or one test file in `failures.files` failing on ≥ 3 pull requests | cycle time |
| **Token cost** | an issue costing ≥ 3× the window's median cost per 100 lines changed, where ≥ 2 such issues share a cause; a `/code-review` or `/security-review` level above what CLAUDE.md's review table gives the change, on ≥ 2 issues; subagents ≥ 50% of an issue's cost on ≥ 2 issues; or `phases.afterPush` plus `phases.afterPushReview` ≥ 40% of an issue's cost on ≥ 2 issues | token cost, joined to cycle time by the pull request that closes the issue |
| **Queue time** | `queue.<check>.median` ≥ 2 minutes for any required check | cycle time |
| **Serial jobs** | a job that others `needs:` in `.github/workflows/ci.yml` takes ≥ 25% of the critical path: its median plus the slowest median of the jobs waiting on it | CI stability, 7-day window |
| **Cancelled runs** | `cancelled.share` ≥ 10% of runner minutes; `cancelled.supersededShare` says how much of it a newer push caused | cycle time |
| **Setup overhead** | setup steps (install, browser install, build) in a job's `steps` ≥ 25% of the job's median | CI stability |
| **A job grown slower** | a required job's 7-day median ≥ 50% above its 30-day median and ≥ 3 minutes, both windows non-partial with ≥ 20 runs. Median, not p90: the 7-day window is inside the 30-day one, so a regression lifts the 30-day p90 to match within days and the ratio reads flat | CI stability |
| **Report not published** | a model missing from the site, older than two days by `generatedAt`, or lacking a field a bar reads | the site, step 1 |

For a cause that clears its bar, note the numbers, the window, the counts behind them and the pull requests or issues they came from. Where several causes clear on the same pull requests, say which explains the most: small slices and avoidable rounds both inflate the balance, and fixing the wrong one changes nothing.

**An open `selection-alarm` issue is the input for its selection cause.** The `alarmIssue` of a crossed bar is its number; name that issue under the cause and file nothing new, since the nightly Selection job keeps its figures current. A crossed bar with `alarmIssue` null is a cause of its own, as any other.

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

Filed issues, one per cause that cleared its bar and was not already tracked, each carrying the numbers behind it; the open alarm issues named for their causes; and a line naming the bars skipped and why: an `unread` verdict, or token cost on a machine without Claude Code's logs.

## Cadence

Monthly, or after the harness changes enough to want a fresh baseline. Balance and cost move slowly, so a weekly run mostly re-reads the same pull requests; the selection bars alarm nightly on their own, so this run reads their alarms rather than waiting on the month.
