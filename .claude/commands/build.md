---
description: Implement one GitHub issue end to end, or every child of a parent issue one at a time, to this repository's process and definition of done
argument-hint: <issue-number> [extra instructions]
---

Implement exactly one GitHub issue in `michaelvanhoutte/cockpit`, end to end — or, given a parent issue, each of its children in turn, per **A parent issue** below.

Arguments: `$ARGUMENTS`. The first token is the issue number; anything after it is an instruction for this run and overrides the defaults below where they conflict.

CLAUDE.md is already loaded into this session and governs how this repository is worked — the writing rules, when to scope, working-in-parallel tools, the testing rules that get skipped most, and the review-findings flow. This command only sequences what CLAUDE.md and its skills already state, in the order a run actually needs them. Never restate a rule here that already lives there — fix it there instead.

1. **Confirm the issue is live.** `gh issue view <number> --json state,title,assignees,body,comments` plus `gh pr list --state all --search <number> --json number,title,state`, per "Check the issue is still open, and unclaimed" under **Scoping new work**. Read the comments — they routinely carry the decision the body doesn't. The `/build <number>` prompt's hook (`.claude/hooks/build-title.mjs`) tells you the title to set as context, so set it first, as it says; a hook cannot set it itself. A later unit with an issue number of its own, reached by step 9, is retitled `#<number> <issue title>` with `set_session_title` — a deferred tool, so load it first with `ToolSearch` (`select:mcp__ccd_session_mgmt__set_session_title`), and skip it where `ToolSearch` finds none. If the sub-issue query under **A parent issue** returns any, it is a parent: after step 2, follow **A parent issue** instead of steps 3–9, ending with steps 10 and 11.
2. **Ask once, before building anything: merge automatically once a pull request is clean, or hold for me to merge by hand?** My answer depends on what else is running, so ask every time rather than assuming. Carry the answer through the rest of this run, including every unit if engineering-plan splits the work into several — do not ask again per unit.
3. **Scope it.** A **scoped** issue already has a populated **Test cases** section carrying a statement list; an issue without one, or still labelled `unsliced`, hasn't been through `engineering-plan` yet. Where it's scoped, sharpen only what's still genuinely fuzzy. Where it isn't, run `engineering-plan`, its design phase first, with the user before writing anything, per **Scoping new work**; each works on this issue and writes back to it, and a ticket that never went through `scoping` starts there. **Stop before step 4 if the issue has no `## Technical design` section and isn't a bug fix**: a missing section means the design phase of `engineering-plan` never ran, and "No design needed: …" counts as run. Run it here with the user, since it interviews the engineer and a subagent can't, add the section (and `## Failure modes` where it applies) to the issue, and only then build. A scoped issue with no `## Model` section isn't fully scoped: name its model by engineering-plan's sizing-step rule and add the section to the issue before step 4, since step 4 otherwise builds it on whatever model this session happens to be. If engineering-plan sizes this as several units, build and ship them one at a time in dependency order — see step 9 on what starts the next one.
4. Do steps 4–6 inside an `Agent` tool call on the model the issue's `## Model` section names — or, for a unit that stays internal to this run, engineering-plan's sizing-step recommendation — rather than in this session; the calling session stays whatever it started as. **Build**, following the conventions already in the code it touches — `packages/shared` is the contract.
5. **Test**, per the `testing` skill. If the capability needs a tier that doesn't exist yet, building it is part of this issue, not a follow-up.
6. **Prove it runs, where Tests' scaling table asks for a browser pass**: start it with `pnpm dev` and drive the changed behaviour in a real browser. Staging only ever carries what has already merged to `main`, so a branch's own changes are never there to see — verify locally, signing in through the stub issuer `pnpm dev` prints rather than a deployed environment's own Google sign-in. Write the walk down as you go, for the pull request body; mark `browser-start` before starting the app and `browser-end` once the walk is written.
7. **Review yourself before pushing, against the commit that's actually about to be pushed**: `/code-review` inline and `/security-review` as its own `Agent` subagent call, both at the level Review findings' own table maps `node scripts/local-changes.mjs`'s answer to, unless that table rules the security review out entirely — both on the diff, both on whichever of the calling session's own model and the unit's recommended one is stronger, even where steps 4–6 ran delegated — a `haiku` unit still gets the session's own review rather than being trusted to catch what a weaker model misses, and an `opus` unit — recommended precisely because the session default was too weak for it — keeps that strength for review too. After a round of fixes, recheck per Review findings' own recheck rule rather than re-running either review whole, and don't mark ready until its findings are fixed or declined. The security subagent's prompt tells it to run `node scripts/session-record.mjs mark review-end security-review <level> <count>` as its last step before reporting, and this session marks its own `/code-review`'s end when that returns, so each review's own length is recorded. `<count>` is how many findings the review reported, 0 for none; a review-end without one reads as unknown. **After each round's fixes, mark its outcome**: `node scripts/session-record.mjs mark review-outcome <kind> <level> <fixed> <declined>`, which refuses counts that do not add up to that review's `review-end` count. A recheck is a round of its own, so it gets its own `review-start`, `review-end` and outcome.

   **Stop before the push if `node scripts/local-changes.mjs` names a change to `docs/architecture.md` that the issue's Technical design did not decide**, and ask the engineer, naming which rule and why, since code grows on whatever the document licenses. Where they agree, the pull request body names the change under a heading of its own, `## Architecture change`.
8. **Ship**, per **Review findings**: draft, ready, wait for checks, refreshing the record on the body after every push; reply to every thread naming the fixing commit, then resolve it. Then, per the answer from step 2: merge it yourself, or say plainly that it's ready and waiting for a human to merge. **A unit isn't finished until its pull request is actually merged** — checks green and threads resolved is not the finish line. Once it has merged, **close the parent** per the section of that name below; a parent's own children reach it here too, so only this step runs it.
9. **Where engineering-plan sized this as several units** — whether each is its own filed issue or stays internal to this run — the next one's build doesn't start until this one is merged into `main`: build it against the merged result, not a stacked branch. Before starting it: check what changed in `CLAUDE.md` and `.claude/` between the commit this run started from and the merged tip — the read named in **Review findings**, since a rule that changed mid-run is otherwise invisible — and repeat step 1 against whichever issue number that unit now has, since real time passed while the previous unit shipped and it needs re-confirming live and unclaimed. Steps 2 and 3 don't repeat: step 2's answer already carries forward, and the unit is already scoped.
10. **Run `session-review` once, when the run is over**: after step 8's merge, or after it says the pull request is ready and waiting for a human, whichever ends the run, and before step 11 so the report stays last. It runs in this session, where the corrections were given, never inside a subagent. With several units it runs after the last, and for a parent per **A parent issue**. A stop to ask the engineer (a missing design at step 3, an architecture change at step 7) is a pause, not the end, so it does not run. The skill leaves its own draft pull request, which this run does not mark ready or merge whatever step 2 answered, and whose checks it does not wait for.
11. **Report honestly.** Test results as they actually came out; anything skipped or narrowed, and why. Where step 2 held a lone child that is its parent's last open sub-issue, say that merging this pull request finishes parent #N and the parent should be closed then. Where `session-review` opened nothing, say nothing about it; otherwise add one line naming its pull request and how many edits it holds.

**A pull request body carries `Part of #N` where GitHub gives it no closing reference**, since GitHub fills that only for a pull request into `main`: on every pull request into a feature branch, `N` is the child it builds; on the final pull request from a feature branch into `main`, `N` is the parent. Reports find the issue from it.

Mark a chapter at each phase boundary, per **Working in parallel**.

**Record each phase boundary on the pull request** with `node scripts/session-record.mjs mark <phase>`, which stamps the time from the clock itself. The phases:

| Mark | When |
|---|---|
| `start` | right after step 2's answer, so waiting on it is not counted; a parent's child marks it once its own branch exists |
| `scoped` | after step 3 |
| `browser-start` / `browser-end` | around step 6's browser pass: starting the app to the walk written; skipped where the table drops the pass |
| `built` | after step 6 |
| `review-start` `<code-review\|security-review> <level>` / `review-end` `<code-review\|security-review> <level> <count>` | `review-start` as each review begins, `review-end` as that review finishes with how many findings it reported (0 for none), never together, per step 7; a second round marks again, and both are kept |
| `review-outcome` `<code-review\|security-review> <level> <fixed> <declined>` | once that round's fixes are done, never earlier, so it does not time the fixing; fixed plus declined equals the round's `review-end` count |
| `pushed` | immediately before the push that opens the draft pull request |
| `ci-start` / `ci-end` `<conclusion>` | around each push's wait for checks, written by the waiter in CLAUDE.md, once per push |

The test runners record their own runs in the same record, so nothing marks those. Every write to the pull request's body — opening it, the browser walk, marking it ready, **and every push after the first**, so a fix's test runs arrive with it — goes through the record's `body` command, which adds the block at the end or replaces it in place and touches nothing around it. A session that skips a marker reads "not recorded" in a report, never zero.

```bash
gh pr view <number> --json body -q .body | node scripts/session-record.mjs body | gh pr edit <number> --body-file -
```

## A parent issue

**A parent is never built itself, and this session builds none of its children.** It orchestrates: every child runs in fresh subagents, so neither this conversation nor an earlier child's work is in the context that builds the next one.

```bash
gh api graphql -F n=<number> -f query='query($n:Int!){repository(owner:"michaelvanhoutte",name:"cockpit"){issue(number:$n){subIssues(first:50){nodes{number title state}}}}}' --jq '.data.repository.issue.subIssues.nodes[]'
```

- **Order the open children** by each one's `## Blocked by`, blockers first, and skip any already closed.
- **One child at a time, never two at once.** The next starts only once the previous one's pull request has merged, per step 9, which also says what to re-read and re-confirm before it starts. Where step 2's answer was to hold, wait for that merge rather than moving on.
- **Stop before a child that isn't scoped, or that lacks a `## Technical design` section and isn't a bug fix**, and ask whether to scope or design it here: both interview the user, which a subagent can't. For the same reason, a subagent that meets a question only the user can answer returns it unbuilt, and this session asks.
- **Run each child as the phases below**, each a foreground `general-purpose` `Agent` call. Its model is the child's `## Model` recommendation; where a child has none, this session takes the one the parent lists beside it, or names one by engineering-plan's sizing-step rule where the parent lists none, and adds the section to the child before its build starts. A prompt carries the issue number, the branch, step 2's answer and the previous phase's report — never a summary of this conversation. The build starts a fresh branch from `origin/main` in this worktree, and stops any `pnpm dev` it started before returning, so the next child never gets served stale code.

| Phase | Steps | Runs as | Model |
|---|---|---|---|
| Build | 3–6, then commit; no push | a subagent | the child's |
| Review | 7's `/code-review`, its fixes and recheck | a subagent, kept to fix later findings through `SendMessage` | the child's |
| Security review | 7's `/security-review`, where Review findings' table asks for it | its own subagent, spawned from this session | the child's |
| Ship | 8: the push and the draft pull request, ready, the waiter, merge | this session; a failing check goes to the Review subagent to fix | — |

The push waits for both reviews, as step 7 says, so their fixes are in the push that opens the pull request rather than a second push whose first CI run is wasted. A child's reviews run on its own model, overriding step 7's stronger-of rule: a parent's children are where that cost multiplies. The security review is spawned from this session because a subagent can't spawn one of its own, and running it inline there ends that subagent on the report. Likewise a subagent returning never ends this session's turn: read its report and start the next phase.

- **Once every child is done, run `session-review` once** per step 10, in this session after the last child's merge or hold, never inside a child's subagent, since a subagent cannot read the conversation. **Then report**, per step 11, one line per child naming its pull request. Step 8 has already closed the parent after the last child merged, per **Close the parent**.

## Close the parent

A parent holds no work of its own, so once its last child has merged it is finished. After a merged pull request, find the issue's parent; an issue with no parent changes nothing.

```bash
gh api graphql -F n=<number> -f query='query($n:Int!){repository(owner:"michaelvanhoutte",name:"cockpit"){issue(number:$n){parent{number subIssues(first:50){nodes{number title state stateReason closedByPullRequestsReferences(first:5,includeClosedPrs:true){nodes{number merged}}}}}}}}' --jq '.data.repository.issue.parent'
```

- **Count the child just merged as closed** whatever its `state` says, since GitHub closes it from the pull request's closing keyword a little after the merge.
- **A sibling still open** leaves the parent untouched.
- **Otherwise every sub-issue is closed, for any reason** (completed, not planned, duplicate): comment once on the parent listing each child with the merged pull request from its `closedByPullRequestsReferences` (the one just merged for this child), or its close reason where none merged, then close it as completed.

```bash
gh issue comment <parent> --body-file <file>
gh issue close <parent> --reason completed
```

