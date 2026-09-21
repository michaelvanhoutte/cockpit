---
description: Implement one GitHub issue end to end, or every child of a parent issue one at a time, to this repository's process and definition of done
argument-hint: <issue-number> [extra instructions]
---

Implement exactly one GitHub issue in `michaelvanhoutte/cockpit`, end to end — or, given a parent issue, each of its children in turn, per **A parent issue** below.

Arguments: `$ARGUMENTS`. The first token is the issue number; anything after it is an instruction for this run and overrides the defaults below where they conflict.

CLAUDE.md is already loaded into this session and governs how this repository is worked — the writing rules, when to scope, working-in-parallel tools, the testing rules that get skipped most, and the review-findings flow. This command only sequences what CLAUDE.md and its skills already state, in the order a run actually needs them. Never restate a rule here that already lives there — fix it there instead.

1. **Confirm the issue is live.** `gh issue view <number> --json state,title,assignees,body,comments` plus `gh pr list --state all --search <number> --json number,title,state`, per "Check the issue is still open, and unclaimed" under **Scoping new work**. Read the comments — they routinely carry the decision the body doesn't. If the sub-issue query under **A parent issue** returns any, it is a parent: after step 2, follow **A parent issue** instead of steps 3–10.
2. **Ask once, before building anything: merge automatically once a pull request is clean, or hold for me to merge by hand?** My answer depends on what else is running, so ask every time rather than assuming. Carry the answer through the rest of this run, including every unit if scoping splits the work into several — do not ask again per unit.
3. **Scope it.** A **scoped** issue already has a populated **Test cases** section carrying a statement list; an issue without one hasn't been through scoping yet. Where it's scoped, sharpen only what's still genuinely fuzzy. Where it isn't, run the `scoping` skill in full before writing anything, per **Scoping new work**. If scoping sizes this as several units, build and ship them one at a time in dependency order — see step 9 on what starts the next one.
4. If the issue (its `## Model` section) or the unit being built (scoping's sizing-step recommendation, for a unit that stays internal to this run) names a model, do steps 4–6 inside an `Agent` tool call using that override rather than in this session; the calling session stays whatever it started as. Otherwise continue here. **Build**, following the conventions already in the code it touches — `packages/shared` is the contract.
5. **Test**, per the `testing` skill. If the capability needs a tier that doesn't exist yet, building it is part of this issue, not a follow-up.
6. **Prove it runs, where Tests' scaling table asks for a browser pass**: start it with `pnpm dev` and drive the changed behaviour in a real browser. Staging only ever carries what has already merged to `main`, so a branch's own changes are never there to see — verify locally, signing in through the stub issuer `pnpm dev` prints rather than a deployed environment's own Google sign-in. Write the walk into the pull request body as you go.
7. **Review yourself before pushing, against the commit that's actually about to be pushed**: `/code-review` inline and `/security-review` as its own `Agent` subagent call, both at the level Review findings' own table maps `node scripts/local-changes.mjs`'s answer to, unless that table rules the security review out entirely — both on the diff, both on whichever of the calling session's own model and the unit's recommended one is stronger, even where steps 4–6 ran delegated — a `haiku` unit still gets the session's own review rather than being trusted to catch what a weaker model misses, and an `opus` unit — recommended precisely because the session default was too weak for it — keeps that strength for review too. After a round of fixes, recheck per Review findings' own recheck rule rather than re-running either review whole, and don't mark ready until its findings are fixed or declined.
8. **Ship**, per **Review findings**: draft, ready, wait for checks; reply to every thread naming the fixing commit, then resolve it. Then, per the answer from step 2: merge it yourself, or say plainly that it's ready and waiting for a human to merge. **A unit isn't finished until its pull request is actually merged** — checks green and threads resolved is not the finish line.
9. **Where scoping sized this as several units** — whether each is its own filed issue or stays internal to this run — the next one's build doesn't start until this one is merged into `main`: build it against the merged result, not a stacked branch. Before starting it: check what changed in `CLAUDE.md` and `.claude/` between the commit this run started from and the merged tip — the read named in **Review findings**, since a rule that changed mid-run is otherwise invisible — and repeat step 1 against whichever issue number that unit now has, since real time passed while the previous unit shipped and it needs re-confirming live and unclaimed. Steps 2 and 3 don't repeat: step 2's answer already carries forward, and the unit is already scoped.
10. **Report honestly.** Test results as they actually came out; anything skipped or narrowed, and why.

Mark a chapter at each phase boundary, per **Working in parallel**.

**Record each phase boundary on the pull request** with `node scripts/session-record.mjs mark <phase>`, which stamps the time from the clock itself. The phases:

| Mark | When |
|---|---|
| `start` | right after step 2's answer, so waiting on it is not counted; a parent's child marks it once its own branch exists |
| `scoped` | after step 3 |
| `built` | after step 6 |
| `review-start` / `review-end` `<code-review\|security-review> <level>` | around each local review; a second round marks again, and both are kept |
| `pushed` | immediately before the push that opens the draft pull request |

Every write to the pull request's body — opening it, the browser walk, marking it ready — goes through the record's `body` command, which adds the block at the end or replaces it in place and touches nothing around it. A session that skips a marker reads "not recorded" in a report, never zero.

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
- **Stop before a child that isn't scoped** and ask whether to scope it here: scoping interviews the user, which a subagent can't. For the same reason, a subagent that meets a question only the user can answer returns it unbuilt, and this session asks.
- **Run each child as the phases below**, each a foreground `general-purpose` `Agent` call. Its model is the child's `## Model` recommendation, or this session's own where it names none. A prompt carries the issue number, the branch, step 2's answer and the previous phase's report — never a summary of this conversation. The build starts a fresh branch from `origin/main` in this worktree, and stops any `pnpm dev` it started before returning, so the next child never gets served stale code.

| Phase | Steps | Runs as | Model |
|---|---|---|---|
| Build | 3–6, then commit, push and open the draft pull request | a subagent | the child's |
| Review | 7's `/code-review`, its fixes and recheck | a subagent, kept to fix later findings through `SendMessage` | the child's |
| Security review | 7's `/security-review`, where Review findings' table asks for it | its own subagent, spawned from this session | the child's |
| Ship | 8: ready, the waiter, merge | this session; a failing check goes to the Review subagent to fix | — |

A child's reviews run on its own model, overriding step 7's stronger-of rule: a parent's children are where that cost multiplies. The security review is spawned from this session because a subagent can't spawn one of its own, and running it inline there ends that subagent on the report. Likewise a subagent returning never ends this session's turn: read its report and start the next phase.

- **Report once every child is done**, per step 10, one line per child naming its pull request. Leave the parent open: closing it, and whatever its body says follows the last child, is the user's call.
