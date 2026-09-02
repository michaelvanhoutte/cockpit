# Cockpit

Unified Inbox & Dashboards. One Cloudflare Worker (`apps/api`) serves the Hono API, SSE and the built SPA (`apps/web`) as static assets on a single origin; `packages/shared` is the contract between them. Node >= 22, pnpm workspace.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` applies the local D1 migrations, seeds the database, builds the SPA if it has never been built, then runs the API on <http://localhost:8787> and the web app on <http://localhost:5173> together. Every step is idempotent, so re-running is safe; Ctrl+C stops both halves. `pnpm dev:api` and `pnpm dev:web` run one alone. `pnpm build`, `pnpm typecheck` and `pnpm test` run across every package.

## Writing

**Say it once, in as few sentences as it takes.** Documents, issues, pull request bodies and review replies are all read by agents on a context budget, so length is a cost paid on every future read.

- **A rule and its reason fit in one or two sentences.** Keep the reason — a rule without one gets argued with — but a clause is usually enough.
- **Name the incident, don't retell it.** "One issue was built whole after it had already merged" carries the same warning as the paragraph reconstructing it. Keep the story only where it is the evidence, and keep it to a sentence.
- **Say it in one place.** A point made in the introduction is not repeated in the section, and a rule stated in a skill is referenced from here rather than restated.
- **Parallel cases are a table or a list**, not prose that walks through each one.
- **Start at the point.** Delete "it is worth noting that", "the requirement is therefore twofold", "worth writing down, because".
- **Cut what the reader can see.** Don't describe the code, the diff or the diagram that follows; say what it means.

## Scoping new work

**Before writing code for any new feature or fix, run the `scoping` skill in `.claude/skills/scoping/`** — sharpening requirements, sizing the vertical slice, enumerating the failure modes of anything that changes state it cannot put back, and generating the statement list. Starting the work triggers it, not the decision to file an issue.

**Check the issue is still open, and unclaimed, at the moment you start it.** Several sessions work this repository at once: "Rename and delete a workspace" (issue 77) was built whole — nine hundred lines, tests and a browser pass — and only then found to have merged hours earlier as pull request 97, with none of it salvageable. Fetching `main` is not this check, and neither is having read the issue an hour ago: it can be closed by work that merged before your branch point, or while you read it.

```bash
gh issue view <number> --json state,title,assignees
gh pr list --state all --search <number> --json number,title,state
```

## Tests

**Follow the `testing` skill in `.claude/skills/testing/` before writing, moving or reviewing any test.** It restates every binding rule, so there is no need to open the strategy document to write a test. `docs/testing-strategy.md` holds the reasoning and is the version of record; open it to change a rule or to settle something the skill does not decide.

The two rules that get skipped most:

- **Test at the lowest level that can prove the behaviour**, and escalate only for what that level physically cannot verify. Never re-prove lower-level coverage higher up the pyramid.
- **Nothing is "working" until the application has been started and the changed behaviour exercised.** Green unit and integration tests are not evidence that the app runs — start it with `pnpm dev` and drive the change in the browser. This is why that command has to stay one command.

## Review findings

**Run `/code-review` yourself before pushing, not only `/security-review`.** Across five pull requests of one run, all twenty findings were code-review findings and the security review correctly found nothing — silence that read, from the transcript, like a review had happened. A local pass runs now; a remote round costs a push, a CI run and fourteen minutes.

**Opening the pull request is not the end of the task — the review runs after the push.** "CI was still pending when I looked" is not a status; it is a note saying nobody looked again. Wait for the checks to settle, then work the findings to the end of the rule below.

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

Run it from inside the repository, in the background, and carry on with something else — `git rev-parse` and gh's `{owner}/{repo}` both need the working directory. Do not poll it by hand and do not finish the turn on a pending check.

**Wait on the commit you pushed, which is why that command names a SHA.** For the seconds around a push, GitHub's head is still the *previous* commit, whose checks are long green — so a waiter that asks "are this pull request's checks pending?" returns immediately, reporting a pass that belongs to code you have replaced. That happened twice in one run, and once was one command away from being merged on.

**Settled means the list of checks stopped changing, not that the ones it saw are done.** `ci.yml` triggers on `push` as well as `pull_request`, while the review workflows and CodeQL trigger only on `pull_request`, so the ordinary sequence — push, `ci.yml` finishes, `gh pr create`, start waiting — reaches a commit with a complete set of *completed* runs and no `claude-review` yet. The loop above therefore compares the whole `name:status` list against the previous poll, which costs at least two polls.

**A finding is not handled until its own review thread says so**, because GitHub never resolves one by itself — a push only adds an *Outdated* badge. Reply naming the commit that fixed it and what changed, then resolve; where the fix did not land or was declined on purpose, reply saying which and leave the thread open. Never resolve without a reply, and never on the strength of a commit message rather than the committed code. All ten findings on "Make the database enforce the schema conventions" (pull request 69) were fixed, pushed, and still read as unanswered: the pull request is the audit trail, not the session. `gh pr view` does not show thread state — query `reviewThreads` for the ids, then `addPullRequestReviewThreadReply` and `resolveReviewThread`.

**Read what `main` has gained before finishing, not only what it has changed.** The rule above landed twenty-two minutes before "Recover from an expired sign-in" (pull request 71) merged, and that session finished without ever reading it.

## Where things are decided

| Document | What it settles |
|---|---|
| `docs/functional-definition.md` | what the product is |
| `docs/architecture.md` | how it is built |
| `docs/testing-strategy.md` | what counts as proof it works |
| `docs/deployment.md` | where it runs and how it gets there |
| `docs/ideas.md` | unscheduled ideas, deliberately not scheduled |

Options documents (`docs/*-options.md`) record integration research. `poc/` holds proofs of concept and is outside the workspace, so it never runs in CI.

**Cite a section by its name, never by its number alone**, and name an issue before giving its number. The numbers are locators inside documents that cross-reference each other; they tell a reader nothing on their own, and in conversation they say nothing at all.

**When you add or change a rule, apply it across the whole change mechanically** by searching for every instance. Four of the thirteen findings on the pull request that added the rule above were that same rule broken elsewhere in the same change, and one sweep missed a whole class because grepping for `§` cannot find issue numbers. The same holds when a fact stops being true: search for the *claim*, not the file you happen to have open — "the browser tier runs against the `pnpm dev` pair" was corrected in three files before anyone searched for the sentence.

**Counts and enumerations are claims as much as sentences are.** A tenth feature area left the same "nine areas" claim standing in three places across two documents; the third only surfaced from searching for the sentence.

**Write file content with `Write` and `Edit`, and keep the shell for commands.** A heredoc into a script into a TypeScript string is three layers of escaping that `\r\n`, a lone backslash and a null byte survive none of — two source files were mangled that way in one session, badly enough that `grep` called them binary.

**Editing a file through the shell is the same rule, and it fails more quietly.** A half-applied scripted edit duplicated a four-line guard in `apps/api/src/accounts/command-service.ts` and all forty tests in the file went on passing; `Edit` refuses instead when its `old_string` does not match.

**Never run a command that discards uncommitted work to get out of a shell problem.** `git checkout <ref> -- .`, `git restore .` and `git reset --hard` take the whole working tree, and nothing was committed to recover from — an earlier version of these paragraphs was lost to a `git checkout origin/main -- .` prefixed onto an unrelated command purely to fix which directory it ran in. Commit first, or `cd`.
