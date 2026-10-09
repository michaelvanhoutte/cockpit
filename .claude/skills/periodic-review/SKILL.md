---
name: periodic-review
description: Cockpit's process for periodically reading what had to be corrected after a build, the review comments left on merged pull requests and the review findings declined there since the last run, working out where each mistake got through or what the review got wrong, and proposing the fix that stops the next build or review repeating it - a numbered table the person approves, then one `unsliced` ticket per approved lesson and one closed record issue per run. Use every few weeks, or when asked to review recent pull requests or issues for process gaps. Hands each approved lesson through `scoping`, `engineering-plan` and `github-issue`; never edits code, workflows, or guidance itself.
---

# Learning from what got through

A mistake that shipped and was fixed is evidence of where the harness let it through, and a review finding declined on purpose is evidence the reviewer got something wrong. This turns that evidence into a proposal the person decides on, not a report — a report gets read once and a ticket gets built. Harness cost and speed belong to [harness-cost-review](../harness-cost-review/SKILL.md), and corrections inside a live session to [session-review](../session-review/SKILL.md).

Every read and filing uses REST (`gh api repos/{owner}/{repo}/...`) or the GitHub MCP tools: a cloud session blocks GraphQL.

## Process

### 1. Find the window

The window starts at the `closed_at` of the latest closed issue labelled `periodic-review`, the record step 6 writes; four weeks before this run's own clock if there is none.

```bash
gh api "repos/{owner}/{repo}/issues?labels=periodic-review&state=closed&per_page=1" --jq '.[0] | {number, closed_at, body}'
```

Its body lists each rejected lesson, which step 4 must not re-propose.

### 2. Read what shipped

Merged pull requests and closed issues since the window start, bodies included — two instances of a mistake rarely share wording:

```bash
gh api "search/issues?q=repo:{owner}/{repo}+is:pr+is:merged+merged:>=<start>&per_page=100" --jq '.items[] | {number, title, body}'
gh api "search/issues?q=repo:{owner}/{repo}+is:issue+is:closed+closed:>=<start>+-label:periodic-review&per_page=100" --jq '.items[] | {number, title, body}'
```

Three kinds of instance count:

- **Correction**: a merged issue or pull request that fixes, reworks or reverses behaviour an earlier built issue shipped, where that issue can be named. A planned follow-up (the next child of a split ticket, the cleanup after a migration) or new scope added on top is not one.
- **Review comment**: a comment or review left on a pull request merged in the window, by a person or a bot. A finding lands in three places, so read all three for each pull request:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments    # inline
gh api repos/{owner}/{repo}/issues/<n>/comments   # top-level, including bots
gh api repos/{owner}/{repo}/pulls/<n>/reviews     # review bodies
```

- **Declined finding**: a review finding declined on a pull request merged in the window, with its reason, read from the same three surfaces and from the body's review summary (already fetched above). A review comment whose reply declines it counts here, not as a review comment.

Count a comment or decline restated on another surface once; add `--paginate` for long lists.

### 3. Place each instance

Open the original issue and pull request and decide where the mistake got through, which decides the fix. A declined finding is placed by what the review got wrong instead (it flagged something intended, misread the change's intent, or raised a nit not worth a round), and its fix is a rule for the reviewer: an edit to CLAUDE.md's "Review findings" section saying what not to flag and why, since local `/code-review` follows CLAUDE.md and `/security-review` has no local file of its own.

| Where it got through | Proposed fix |
|---|---|
| The case was never in the issue's test list | Missing test coverage for that area, or a gap in how test lists are drafted |
| The case was listed or a rule existed, and it was skipped anyway | A test or mechanical check, never another rule |
| No rule covered it | A rule where the agent reads it at that moment |
| The design was right as specified and reversed once seen | A scoping lesson, kept separate from build lessons |

### 4. Group and qualify

Group instances that teach the same lesson, by the mistake and not the wording. A lesson qualifies on one correction, or on at least two review comments, or two declined findings, of the same kind. Where a class of mistakes has two or more instances, the fix is one invariant test, not a patch per instance; a reviewer lesson's fix stays the rule step 3 names.

Drop a lesson whose fix already landed, that an open issue covers (match on body, not title), or that the previous record rejected, unless an instance since then is new.

### 5. Keep the guidance lean

- Prefer a test or check over prose wherever one can decide the case.
- A prose proposal edits an existing rule in place or names the rule it replaces, and shows its net change in lines.
- A proposal whose check makes a rule redundant also removes that rule.

### 6. Propose, file, record

Show the candidates in the conversation as a numbered table, recurring classes first: lesson, instances (issue or pull request numbers), the row of step 3 (for a reviewer lesson, marked as one, what the review got wrong), proposed fix with net lines. The person approves, edits or rejects each; file nothing before they answer.

Hand each approved one through [scoping](../scoping/SKILL.md), [engineering-plan](../engineering-plan/SKILL.md) and [github-issue](../github-issue/SKILL.md), as an `unsliced` ticket, its instances in **Problem**.

End with one record: create an issue labelled `periodic-review` with the MCP `issue_write` (creating the label first with `gh api repos/{owner}/{repo}/labels -f name=periodic-review -f color=5319e7` if absent), listing every candidate with its outcome, a ticket number or a one-line reason for rejecting it, then close it. Its close date anchors the next run, so create it even when nothing was approved.

The skill itself edits nothing.
