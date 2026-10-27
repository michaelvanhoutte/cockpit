---
name: harness-cost-review
description: Cockpit's process for periodically checking whether the harness - CI, local reviews and the session's own waiting on them - is too slow or too expensive for the development it gates, and why - reading the cycle-time, selection and CI stability answers from the Harness Monitor and pnpm cost:issue, applying one bar per cause (harness outweighing coding, unselective tests, tests that skip too much, slices too small, avoidable rounds, repeating failures, token cost, queue time, serial jobs, cancelled runs, setup overhead, a job grown slower, a report not published), then filing one issue per cause for a person to decide. Never counts anything a tool already measures, never a report, and never on an impression without a sampled window behind it. Hands each candidate through scoping, engineering-plan and github-issue; never edits workflows, branch-protection, or review prompts itself.
---

# Is the harness too heavy for the development

The harness is everything a change waits on after it is written: CI, the local reviews, and the tokens a session spends waiting and fixing. It is too heavy when it costs more than the development it gates, and each cause needs a different fix — so this names the cause, not only the symptom, and files one issue per cause for a person to decide. **It never removes or weakens a check itself**, and **a check that rarely fails is never a candidate**: it is guarding code that is rarely broken.

**Tools measure; this skill reads and decides.** Every number below comes from a tool's numbers, which the Harness Monitor holds. Where a bar needs a number no tool has yet, the bar names the issue that adds it: skip that bar and say so, never count it by hand.

## Process

### 1. Read the answers

The Harness Monitor draws each report from rows CI sends it, and answers the same view as JSON at its page's address with `?format=json`. Read the address off the repository variable (`gh variable get HARNESS_MONITOR_URL`), then each answer with `curl -fsSL "<monitor>/<page>?format=json" -o <scratch>/<name>.json`, never built here: the page, the bars and the open alarms all read the same rows, so a copy built from another source would disagree with them.

| Answer | Read from | Gives |
|---|---|---|
| Cycle time | `<monitor>/cycle-time?format=json` (30 days; `&period=7d`, `90d` or `all` for others) | `pulls`, per merged pull request: `balance` (coding against harness), `rounds` (each with `red`, `failed`, `last` and its `checks`), `flukes`, `localReviews`, `size`; `windows` of 7, 14 and 30 days, each with `balance`, `rounds`, `checks` (rounds, red, flukes and flukePulls per check), `failures` (`steps`, `files`), `queue` per check in milliseconds, `cancelled` |
| Selection | `<monitor>/selection?format=json` (14 days; `&period=` and `&job=test` or `e2e` to narrow) | `bars.items`: each headline figure with its `verdict`; `forcedFullRules`: a row per job and rule above its `paths`; `misses` |
| CI stability | `<monitor>/stability?format=json` (`windows` of 7 and 30 days) | `windows[].workflows[].jobs[]`: the job's `durations` (`median`, `p90`, `count`, in milliseconds) and each step's, on `main` |

These tools run on this machine, since they read Claude Code's own logs:

| Tool | Command | Gives |
|---|---|---|
| Token cost | `pnpm cost:issue --since <window start> --json` | per issue: tokens, API-equivalent cost, subagents, review passes by level; tokens and cost also split by session phase (`phases`) |
| One run | `pnpm cost:issue --run <issue> [--json]` | a row per pull request of an issue and its children, then a total: start and end, coding time, each review's time with reported, fixed and declined, each CI wait's time and outcome, token cost; "not recorded" where a mark was skipped |

Each tool's README says what its figures count and leave out; read it before quoting a number from it. The Monitor holds history only from the day its rows were first sent, so check each window's `firstDay` against the oldest day held first: selection gives it as `storedFrom`, cycle time as the oldest `pulls[].mergedAt`, and stability has none of its own, so it takes the cycle-time answer's. A window starting before it is partial: read it as the days held, and a partial window clears no bar that names a window length.

**An answer the Monitor does not give, whose newest stored row is more than two days old, or that lacks a field a bar reads is itself a finding** (*Report not published* below), never a line saying it was not read: a report nobody can read is a report nobody is watching. The newest stored row is `newestMerge` at `<monitor>/v1/cycle-time` and `<monitor>/v1/selection`, and `newestRun` at `<monitor>/v1/stability`. Skip only the bars that answer feeds. Token cost has no answer on the Monitor; on a machine without Claude Code's logs, skip its bar and say so.

### 2. Apply one bar per cause

Read the 14-day window (the cycle-time answer's window with `days` 14) unless a bar says otherwise. A bar needs at least 20 merged pull requests in its window, or the count it names; *Report not published* needs none. These thresholds are starting values: when one fires on noise or misses a real cause, change it here. The selection bars' numbers are the exception, since the nightly job sends them to the Monitor from `BARS` in `tools/selection/src/model.js`: change them there.

| Cause | Bar | Read from |
|---|---|---|
| **Harness outweighs coding** | the window's `balance.ratio.median` > 1, or more than half its `balance.dots` with a `ratio` above 1, over ≥ 20 recorded pull requests (`pulls.withRecord`) | cycle time |
| **Not selective enough** | a `bars.items` entry with `id` `e2e-forced-full` or `test-forced-full` and `verdict` `crossed`: a job forced to run everything on ≥ 25% of the pull requests that ran it. Read the verdict, never recount: `cause` names the rule behind a forced-full bar and its row in `forcedFullRules` the paths; `unread` (`unread` says whether the window or the figure) is no finding | selection |
| **Tests skip too much** | the `bars.items` entry `misses` with `verdict` `crossed`: any test that failed on `main` where the pull request that merged did not run it | selection |
| **Slices too small** | pull requests under 100 lines changed (`size.additions + size.deletions`) with a median `balance.ratio` ≥ 2 (both per pull request in `pulls`), over ≥ 8 of them: the fixed cost of a round outweighs the change | cycle time |
| **Avoidable rounds** | the window's `rounds.perPull.median` ≥ 2; or red rounds whose `failed` includes `Checks` (lint, typecheck, build — all runnable before a push) on ≥ 10% of rounds (the `rounds` of `pulls`, or the `Checks` row of the window's `checks`) | cycle time |
| **Repeating failures** | a row of the window's `checks` with `flukePulls` ≥ 3 and `flukes` ≥ 5% of its `rounds`; or one `failures.files` row with ≥ 3 `pulls` | cycle time |
| **Token cost** | an issue costing ≥ 3× the window's median cost per 100 lines changed, where ≥ 2 such issues share a cause; a `/code-review` or `/security-review` level above what CLAUDE.md's review table gives the change, on ≥ 2 issues; subagents ≥ 50% of an issue's cost on ≥ 2 issues; or `phases.afterPush` plus `phases.afterPushReview` ≥ 40% of an issue's cost on ≥ 2 issues | token cost, joined to cycle time by the pull request that closes the issue |
| **Queue time** | `queue.<check>.median` ≥ 120000 (milliseconds) for any required check | cycle time |
| **Serial jobs** | a job that others `needs:` in `.github/workflows/ci.yml` takes ≥ 25% of the critical path: its `durations.median` plus the slowest median of the jobs waiting on it | CI stability, the 7-day window |
| **Cancelled runs** | `cancelled.share` ≥ 10% of runner minutes; `cancelled.supersededShare` says how much of it a newer push caused | cycle time |
| **Setup overhead** | setup steps (install, browser install, build) in a job's `steps` ≥ 25% of the job's `durations.median` | CI stability |
| **A job grown slower** | a required job's 7-day `durations.median` ≥ 50% above its 30-day one and ≥ 3 minutes, both windows non-partial with ≥ 20 runs (`durations.count`). Median, not p90: the 7-day window is inside the 30-day one, so a regression lifts the 30-day p90 to match within days and the ratio reads flat | CI stability |
| **Report not published** | an answer the Monitor does not give, whose newest stored row is older than two days, or that lacks a field a bar reads | the Monitor, step 1 |

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
