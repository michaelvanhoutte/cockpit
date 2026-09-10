---
name: periodic-review
description: Cockpit's process for periodically reading merged pull requests, their review threads, and closed issues since the last run, and filing one issue per class of finding that recurs at least twice - never a report, and never on a single instance. Use every few weeks to look back over recent work, or when asked to review recent pull requests or issues for process gaps. Hands each class through `scoping` and `github-issue`; never edits code, workflows, or guidance itself.
---

# Looking back over recent work

A single bad review comment is noise; the same one on nine pull requests is a hole in the harness. This finds the holes by counting, and files one issue per hole rather than writing up what was read — a report gets read once and an issue gets built.

## Process

### 1. Find the window

The window is since the last run, not a fixed lookback. Every issue this skill files carries the `periodic-review` label, so the last run's start is:

```bash
gh label create periodic-review --color 5319e7 --force
gh issue list --label periodic-review --state all --search "sort:created-desc" -L 1 --json createdAt
```

`--force` makes the first line safe to run every time — it updates the label instead of erroring when it already exists. No result from the second line means this is the first run: default to four weeks back. A class sitting at one instance when the window advances past it stays uncounted forever after — the same gap "Buy the invariant on the second finding of a class, not the third" (issue 286) leaves open in its own "Out of scope", and not solved here either.

### 2. Read what shipped in the window

```bash
gh pr list --state merged --search "merged:>=<window-start>" --json number,title,url,mergedAt -L 200
gh issue list --state closed --search "closed:>=<window-start> -label:periodic-review" --json number,title,url,closedAt,body -L 200
```

The label exclusion keeps this skill's own earlier output out of its own input. Read every closed issue's body, not just its title — the same reason the pull-request path below reads full threads: two instances of a class rarely share wording, and a title-only read misses the ones that don't.

From the merged pull requests, sample the 25 most recently *merged* for a review-thread read — the sample size "Fail on the writing rules a script can decide, instead of finding them in review" (issue 278) itself used. Sort by `mergedAt` explicitly first: the list above comes back in creation order, not merge order, and a pull request opened early but merged late is exactly the kind that draws the most review. For each sampled pull request, read the whole thread, not only its opening comment — a later reply is often the one that says a finding was already spun into its own issue:

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100){
          nodes{ comments(first:10){ nodes{ body path } } }
        }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F number=<n>
```

### 3. Group into classes

A class is the mistake shared, not the wording — "cites a section by number" is one class whether it names `§9.1` or `rule 2`. For each class, note which file actually governs the behaviour it broke: `CLAUDE.md`, a `.claude/skills/*/SKILL.md`, a `.claude/commands/*.md`, a `docs/*.md`, or a script or test if the fix is genuinely code. Most of what turns up here is process, not logic — issue 278's sample was 40% prose — so do not assume the governing file is code by default.

Keep the raw count and which pull request or issue each instance came from. That list is the sample, and it goes in the filed issue.

### 4. File only what recurs

**A class needs at least two instances in the sample to be filed** — the bar issue 278's own sample draws, and the one issue 286 draws for the same reason. Two on the same pull request count as much as two across different ones — issue 286 allows both. A class shown once is dropped here, not carried anywhere: there is no report to hold it in reserve for next time.

### 5. Size and file each class

Each class that clears the bar is already one unit — [scoping](../scoping/SKILL.md)'s "Size it as a vertical slice" step needs no further split. Run its remaining steps in brief: failure modes only if the fix touches state that cannot be put back (rare for a process or guidance fix); a statement list per its "Generate the statement list" step, and where the fix is prose rather than code, "None" is the honest answer most recent process issues already give.

Hand the sized class to [github-issue](../github-issue/SKILL.md) for the body: the count and the sample go in **Problem**, naming the governing file from step 3 there as context for what is broken. **What to build** stays the end-to-end behaviour with no path in it, per github-issue's own rule. File in any order — classes from one run are independent of each other. After filing, apply the `periodic-review` label so the next run's window starts here.

## Output

Filed issues, one per class that recurred at least twice, each carrying the count and the sample it came from and naming the file its fix belongs in. Nothing is edited by this skill itself, and nothing is written down for a class seen only once.
