# Cockpit

Unified Inbox & Dashboards. One Cloudflare Worker (`apps/api`) serves the Hono API, SSE and the built SPA (`apps/web`) as static assets on a single origin; `packages/shared` is the contract between them. Node 24 (>= 24.16), pnpm workspace.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` applies the local D1 migrations, seeds the database, builds the SPA if it has never been built, then runs the API, the web app and the stub issuer you sign in against together, printing each address. Every step is idempotent, so re-running is safe; Ctrl+C stops all of them. `pnpm dev:api` and `pnpm dev:web` run one alone. `pnpm build`, `pnpm typecheck` and `pnpm test` run across every package.

**Read the ports off what `pnpm dev` prints.** Each worktree derives its own set from its path, so several can run the app at once. Never write a port into a document or a test — ask `portsFor` (`scripts/lib/ports.mjs`), as `playwright.config.ts` does.

## Deployed data is real

**Nothing may delete, re-seed, wipe or restore over production or staging.** Both hold real data, and staging's existing rows are the only proof that a migration, and the code either side of it, still reads what is already there. So migrations are expand-then-contract, and `pnpm backup:export` runs before anything that writes to either. Restated here from `docs/deployment.md`, the document of record, because a session that never opens it still has to obey; the exceptions it allows are in its "The environments" and "Migrations and rollback".

## Writing

**Say it once, in as few sentences as it takes.** Documents, issues, pull request bodies and review replies are all read by agents on a context budget, so length is a cost paid on every future read.

- **Give the instruction, then the reason in a clause.** A rule without a reason gets argued with; a rule buried in a paragraph of background gets skimmed.
- **Say what to do, not how the tool behaves.** Reach the mechanism only if the reason needs it.
- **No history.** The incident, the sampling, the costs and what was weighed stay in the issue or pull request that decided it. A document says what is true now and what to do about it.
- **Say it in one place.** A rule stated in a skill is referenced from here, not restated — except one that has to hold in a session that never loads that skill, and a restatement claiming that exception says so where it stands.
- **Parallel cases are a table or a list**, not prose walking through each one.
- **Start at the point, and cut what the reader can see.** No "it is worth noting that"; no describing the code, diff or table that follows.

**Four rules are checked rather than reviewed**, over every Markdown file outside `poc/`: an issue number with no title named for it, a `§N` or `rule N` citation resolving to nothing the file offers, an unbalanced `**`, and a paragraph appearing near-verbatim in two places. `pnpm test:scripts` runs them, as does CI's `Checks` job; `scripts/lib/writing-rules.mjs` holds each one's reach. The same run reports the counting words on the lines you touched — "three things", "both", "nine areas" — as a prompt to check the claim, not a failure.

## Starting an issue

**`/issue <number>` is the entry point for issue work.** It sequences everything below — confirm the issue is live, scope, build, test, prove it runs, review, ship — so assembling the phases by hand is only for work that never had an issue number.

## Scoping new work

**Run the `scoping` skill before writing code for any feature or fix.** It decides whether the work has to be seen first, sharpens the requirements, sizes the vertical slice, enumerates the failure modes of anything that changes state it cannot put back, and produces the statement list. Starting the work triggers it, not the decision to file an issue.

**Check the issue is still open and unclaimed at the moment you start it.** Several sessions work this repository at once, so it can be closed by work that merged before your branch point, or while you read it. Fetching `main` is not this check.

```bash
gh issue view <number> --json state,title,assignees
gh pr list --state all --search <number> --json number,title,state
```

**Work with no issue number needs the same check, asked of the files** — and asked again before you mark the pull request ready, since the pull request that supersedes yours can be open, and not yet touching your file, when you begin.

```bash
gh pr list --state open --json number,title,files --jq '.[] | select(any(.files[]; .path == "<the file>")) | "\(.number) \(.title)"'
```

## Working in parallel

The desktop-app tools named here are missing from a terminal, scheduled or remote session: take the fallback where a rule gives one, and skip the rule where it does not.

**A finding outside the issue's statement list becomes a chip, not a commit.** Call `spawn_task` with what a fresh session needs — file paths, the symptom, what you were doing — then carry on with your own scope. Fix it inline only where the current work cannot be proven without it, and say so in the pull request body. Without `spawn_task`, open a bare issue naming the symptom; it is a pointer rather than a brief, so the `github-issue` skill and the scoping it presumes do not apply.

**Mark a chapter at each phase boundary** — scoping settled, built, review findings in, browser pass done — with `mark_chapter`, which is what lets a long thread be re-entered without scrolling it. Three to eight in a session, not one per tool call.

**Rename the session with `set_session_title` when its scope moves**, since the sidebar is how parallel threads are told apart.

**`/where` prints this session's position** for a reader who has lost the thread.

## Tests

**Follow the `testing` skill before writing, moving or reviewing any test.** It restates every binding rule, so writing a test needs nothing else. `docs/testing-strategy.md` is the version of record: open it to change a rule, or to settle what the skill does not decide.

Two of its rules are restated here because this file is in context always and the skill only once something triggers it:

- **Test at the lowest level that can prove the behaviour**, and escalate only for what that level physically cannot verify. Never re-prove lower-level coverage higher up the pyramid.
- **Nothing is "working" until the app has been started and the changed behaviour driven in the browser.** Green unit and integration tests are not evidence that the app runs. The exception is a change the table below drops the browser pass for.

**Write that walk down in the pull request** — what to open, what to click, what should happen. You have already driven it, and recording it saves the next person rediscovering it. Keep it to what a reader would not guess, and where a change has no product surface to drive, say that instead.

**Scale what you run before a push to what changed.** `node scripts/local-changes.mjs` answers for the working tree; ask it rather than judging by eye.

| Change | Runs |
|---|---|
| only `docs/`, `.claude/` or root markdown | the writing rules and `pnpm test:scripts`; no browser pass |
| only test files, or a test deletion | that package's suite and `pnpm test:scripts`; no browser pass |
| anything touching product code | everything the definition of done lists today |

## Review findings

**Run `/code-review` and `/security-review` yourself before pushing, each at the level the change earns.** They are the only review a change gets, so nothing downstream will catch what they miss. `node scripts/local-changes.mjs`'s answer maps to a row:

| Change | `/code-review` | Security review |
|---|---|---|
| `documentation only` | `low` | none |
| `tests only (…)`, or the unit's recommended model is `haiku` | `medium` | none |
| `product changed` | `high` | none |
| `product changed (stored data)` | `xhigh` | none |
| `product changed (security)`, with or without stored data | `high`, or `xhigh` with stored data | as its own agent |

**Type the level into the command** — `/code-review xhigh`, never a bare `/code-review`, which reuses whatever level was typed last rather than the one the table gives. Never `max`, slow enough on a real diff to get skipped, and never `ultra`: a billed cloud review only the user can start.

**Recheck a round of fixes instead of re-reviewing the whole diff.** One targeted `/code-review` pass over the files the fixes touched, and a targeted `/security-review` pass only where a fix itself touches a security path. Run a full second pass, at the diff's own row above, only where a fix touches a stored-data path, or the fixes change more than 25% of the original diff or 40 lines, whichever is larger. Fix or decline whatever the recheck finds without another local pass.

**Where the table asks for a security review, run it as its own foregrounded `general-purpose` `Agent` call, never inline via `Skill`.** Its prompt ends "your final reply must contain the markdown report and nothing else", which inline becomes the session's own last turn, leaving the work reviewed on an unpushed commit. As a subagent, on the session's model or stronger, that line binds the subagent instead and the session gets a report back to fix against and push in the same turn. `/code-review` carries no such line and runs inline.

**Open the pull request as a draft while the work is unfinished, and mark it ready when it is done.** Nothing fires on the transition — `ci.yml` names no `types`, so it runs on every push — so the draft is a signal to whoever reads the list, not a gate.

```bash
gh pr create --draft --title "..." --body "..."
gh pr ready <number>
```

**Check `gh pr view <number> --json mergeable,mergeStateStatus` before waiting on anything.** A `CONFLICTING` pull request gets no checks at all, so the waiter below would never return. That is the one case this file permits merging `main` in for.

**Opening the pull request is not the end of the task: wait for the checks to settle, then fix what they report.** Start the waiter on the push, in the background, from inside the repository — `git rev-parse` and gh's `{owner}/{repo}` both need the working directory.

```bash
sha=$(git rev-parse HEAD); before=
while :; do
  runs=$(gh api repos/{owner}/{repo}/commits/$sha/check-runs --jq '[.check_runs[] | .name + ":" + .status] | sort | .[]')
  [ "$(gh pr view <number> --json headRefOid -q .headRefOid)" = "$sha" ] && [ -n "$runs" ] &&
    [ "$runs" = "$before" ] && ! printf '%s\n' "$runs" | grep -qv ':completed$' && break
  before=$runs; sleep 30
done
gh api repos/{owner}/{repo}/commits/$sha/check-runs --jq '.check_runs[] | [.name, .conclusion] | @tsv'
```

It names a SHA because for the seconds after a push GitHub's head is still the previous commit, whose checks are long green. It compares the whole list against the previous poll because a commit's checks are registered as their jobs start, so an early poll can find a complete set of *completed* runs with another still to appear. Do not poll by hand, and do not end a turn on a pending check.

**A remote or cloud session has no `gh` to run that loop in.** Poll `pull_request_read`'s `get_check_runs`/`get` through the GitHub MCP tools, and schedule the next check with `send_later` rather than trusting the PR-activity webhook, which does not fire on every transition.

**A finding is not handled until its own review thread says so**, because a push only adds an *Outdated* badge and GitHub never resolves a thread itself. Reply naming the commit that fixed it and what changed, then resolve; where the fix did not land or was declined on purpose, reply saying which and leave the thread open. Never resolve without a reply, and never on the strength of a commit message rather than the committed code. `gh pr view` does not show thread state — query `reviewThreads` for the ids, then `addPullRequestReviewThreadReply` and `resolveReviewThread`.

**Merge `main` into the branch only when GitHub reports the pull request conflicted.** It lands squashed and CI already tests the branch merged with `main`, so a clean merge buys nothing that lands and only restarts CI.

**Read what `main` has gained before finishing, not only what it has changed.** This file is read into a session once, at the start, so a rule that merges while you work changes nothing you believe until you look. Diff against the commit you started from — not the merge-base with `origin/main`, which the conflict-merge above moves to `origin/main` itself, silencing the diff on exactly what that merge brought in.

```bash
git fetch origin main
git diff <the SHA HEAD was when you started>..origin/main --stat -- CLAUDE.md .claude/
```

Anything it prints is a rule you are already working under and have not read.

## Where things are decided

| Document | What it settles |
|---|---|
| `docs/functional-definition.md` | purpose, problems, decisions and non-functional requirements, plus a map to the rest |
| `docs/product/*.md` | what the product is, one file per area |
| `docs/design-system.md` | how it looks |
| `docs/architecture.md` | how it is built |
| `docs/testing-strategy.md` | what counts as proof it works |
| `docs/deployment.md` | where it runs and how it gets there |
| `docs/ideas.md` | unscheduled ideas, deliberately not scheduled |

Options documents (`docs/*-options.md`) record integration research. `poc/` holds proofs of concept and is outside the workspace, so it never runs in CI.

**Cite a section by its name, never by its number alone**, and name an issue before giving its number: a number is a locator, and tells the reader nothing on its own.

**When you add or change a rule, or a fact stops being true, sweep the whole repository for it** rather than fixing the file you happen to have open. Search for the claim itself, and remember that counts and enumerations are claims too — "nine areas" goes stale exactly as a sentence does.

**Write file content with `Write` and `Edit`, and keep the shell for commands.** A heredoc through layers of escaping mangles `\r\n`, lone backslashes and null bytes, and a half-applied scripted edit fails silently where `Edit` refuses on an `old_string` that does not match.

**Never run a command that discards uncommitted work**, whatever shell problem it would solve: `git checkout <ref> -- .`, `git restore .` and `git reset --hard` take the whole working tree, and nothing was committed to recover from. Commit first, or `cd`.
