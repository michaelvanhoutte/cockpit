---
name: periodic-review
description: Cockpit's process for periodically reading merged pull requests, their review threads, and closed issues since the last run, and filing one issue per class of finding that recurs at least twice and isn't already tracked - never a report, and never on a single instance. Use every few weeks to look back over recent work, or when asked to review recent pull requests or issues for process gaps. Hands each class through `scoping` and `github-issue`; never edits code, workflows, or guidance itself.
---

# Looking back over recent work

A single bad review comment is noise; the same one on nine pull requests is a hole in the harness. This finds the holes by counting, and files one issue per hole rather than writing up what was read — a report gets read once and an issue gets built.

## Process

### 1. Find the window

The window is since the last time a run filed something, not a fixed lookback and not simply "since this last ran." Every issue this skill files carries the `periodic-review` label, so that start is:

```bash
gh label create periodic-review --color 5319e7 --force
gh issue list --label periodic-review --state all --search "sort:created-desc" -L 1 --json createdAt
```

`--force` makes the first line safe to run every time — it updates the label instead of erroring when it already exists. No result from the second line means no run has ever filed anything yet, so there is no anchor: default to four weeks back from *that run's own clock* — a window that rolls forward every time this runs, and a singleton close to its edge can still fall out of it before anything has ever been filed.

Once something has been filed, the anchor holds: a later run that files nothing — every class stayed a singleton, or every recurring one was already tracked (step 4) — leaves the window exactly where the filed issue set it, on purpose, so a class sitting at one instance stays in view rather than falling out the moment an unanchored window would have moved past it. That guarantee belongs to the closed-issues read in step 2, which is bounded by this window; it does not reach the pull-request sample there, which is bounded by count instead. It also still leaves the gap "Buy the invariant on the second finding of a class, not the third" (issue 286) names in its own "Out of scope" — nothing here carries a class's count *across* a run that does file something — and this skill doesn't solve that either.

### 2. Read what shipped in the window

```bash
gh pr list --state merged --search "merged:>=<window-start> sort:created-desc" --json number,title,url,mergedAt -L 200
gh issue list --state closed --search "closed:>=<window-start> -label:periodic-review sort:created-desc" --json number,title,url,closedAt,body -L 200
```

`sort:created-desc` is there because `--search` otherwise ranks by relevance, not by date — the same qualifier the window-finding step above already relies on — so the 200-item cap keeps a predictable slice rather than an arbitrary one; raise it if the window is unusually large. The label exclusion keeps this skill's own earlier output out of its own input. Read every closed issue's body, not just its title — the same reason the pull-request path below reads full threads: two instances of a class rarely share wording, and a title-only read misses the ones that don't.

From the merged pull requests, sample the 25 most recently *merged* for a review read — the sample size "Fail on the writing rules a script can decide, instead of finding them in review" (issue 278) itself used. This sample is bounded by count, not by the window, so it does not carry step 1's window-hold guarantee: once 25 pull requests have merged since an older one, that older one's threads drop out of the sample regardless of whether the window is still open. Sort this sample by `mergedAt`, not `createdAt`: a pull request opened early but merged late is exactly the kind that draws the most review, and the cap above sorted by creation only to keep the 200-item read predictable, not to answer this. A finding lands in three different places on a pull request here — an inline thread, a top-level comment (this repo's own security-review bot posts one on every pull request, inline or not), or a review's summary body — so read all three, not only the inline threads:

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

Each list is capped (100 threads, 20 replies per thread, 100 top-level comments, 20 reviews) — a known truncation, not a claim that nothing past it exists.

### 3. Group into classes

A class is the mistake shared, not the wording — "cites a section by number" is one class whether it names `§9.1` or `rule 2`. For each class, note which file actually governs the behaviour it broke: `CLAUDE.md`, a `.claude/skills/*/SKILL.md`, a `.claude/commands/*.md`, a `docs/*.md`, or a script or test if the fix is genuinely code. Most of what turns up here is process, not logic — issue 278's sample was 40% prose — so do not assume the governing file is code by default.

Keep the raw count and which pull request or issue each instance came from — but count each underlying occurrence once. The security-review bot's top-level comment restating an inline thread's finding, or a reply repeating what the opening comment already said, is the same occurrence read from two of the surfaces step 2 pulls, not two. That list is the sample, and it goes in the filed issue.

### 4. File only what recurs

**A class needs at least two instances in the sample to be filed** — the bar issue 278's own sample draws, and the one issue 286 draws for the same reason. Two on the same pull request count as much as two across different ones — issue 286 allows both. A class shown once is dropped here, not carried anywhere: there is no report to hold it in reserve for next time.

**Unless an open `periodic-review` issue already covers it.** A class that recurs because its fix hasn't shipped yet will clear the bar again on every later run; check whether one already names the same mistake, matching on body rather than title for the same reason step 2 does:

```bash
gh issue list --label periodic-review --state open --json number,title,body -L 100
```

Skip filing if one matches — the open issue is the record, not a fresh one.

### 5. Size and file each class

Each class that clears the bar is already one unit — [scoping](../scoping/SKILL.md)'s "Size it as a vertical slice" step needs no further split. Run its remaining steps in brief: failure modes only if the fix touches state that cannot be put back (rare for a process or guidance fix); a statement list per its "Generate the statement list" step, and where the fix is prose rather than code, "None" is the honest answer most recent process issues already give.

Hand the sized class to [github-issue](../github-issue/SKILL.md) for the body: the count and the sample go in **Problem**, naming the governing file from step 3 there as context for what is broken. **What to build** stays the end-to-end behaviour with no path in it, per github-issue's own rule. File in any order — classes from one run are independent of each other. After filing, apply the `periodic-review` label so the next run's window starts here.

## Output

Filed issues, one per class that recurred at least twice and wasn't already tracked, each carrying the count and the sample it came from and naming the file its fix belongs in. Nothing is edited by this skill itself, and nothing is written down for a class seen only once.
