# Cockpit

Unified Inbox & Dashboards. One Cloudflare Worker (`apps/api`) serves the Hono API, SSE and the built SPA (`apps/web`) as static assets on a single origin; `packages/shared` is the contract between them. Node >= 22, pnpm workspace.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` applies the local D1 migrations, seeds the database, builds the SPA if it has never been built, then runs the API on <http://localhost:8787> and the web app on <http://localhost:5173> together. It is safe to re-run — every setup step is idempotent — and Ctrl+C stops both halves. Use `pnpm dev:api` or `pnpm dev:web` to run one alone.

`pnpm build`, `pnpm typecheck` and `pnpm test` run across every package.

## Scoping new work

**Before writing code for any new feature or fix, run the `scoping` skill in `.claude/skills/scoping/`** — sharpening fuzzy requirements, sizing the work as a vertical slice, and generating its statement list. This applies whether the work is going straight into this session or being filed as a GitHub issue first; filing is not what triggers it.

## Tests

**Follow the `testing` skill in `.claude/skills/testing/` before writing, moving or reviewing any test.** It triggers on its own and restates every binding rule, so there is no need to open the strategy document to write a test. `docs/testing-strategy.md` holds the reasoning and is the authoritative version of record; open it to change a rule or to settle something the skill does not decide.

The two rules that get skipped most, repeated here because they are the ones that cost the most:

- **Test at the lowest level that can prove the behaviour**, and escalate only for what that level physically cannot verify. Never re-prove lower-level coverage higher up the pyramid.
- **Nothing is "working" until the application has been started and the changed behaviour exercised.** Green unit and integration tests are never evidence that the app runs — start it with `pnpm dev` and drive the change in the browser. This is why the command above has to stay one command.

## Review findings

**Run the review yourself before pushing.** `/code-review` reads the same diff the pull request's reviewer will, and it runs now, where a remote round costs a push, a fresh CI run and fourteen minutes of waiting. Five of the eight findings in the first round on "Recover from an expired sign-in instead of failing silently" (pull request 71) were a single mechanical rule — a section cited by its number — that takes no judgement to find. Two rounds on that change spent twenty-eight minutes waiting to be told things a local pass says immediately.

**A finding is not handled until its own review thread says so.** Fixing the code and pushing is half the job: GitHub never resolves a thread by itself. A push only adds an *Outdated* badge, and only when the lines the comment was anchored to have left the diff; merging changes nothing either. So for every thread, reply naming the commit that fixed it and what changed, then resolve it. Where the fix did not land, or the finding was declined on purpose, reply saying which and leave the thread open. Never resolve a thread without a reply, and never resolve one whose fix has not been checked against the committed code rather than against the commit message that claims it.

The pull request is the audit trail; the session that produced the fix is not. All ten findings on "Make the database enforce the schema conventions, not just the callers" (pull request 69) had been fixed and pushed, and all ten still read as open and unanswered — from the pull request alone there was no evidence that any of the review had been handled, and the reasonable conclusion was that something had broken.

`gh pr view` does not show thread state at all. Query `reviewThreads` on the pull request for the ids, then `addPullRequestReviewThreadReply` and `resolveReviewThread`.

**Read what `main` has gained before finishing, not only what it has changed.** Merging it in is routine; noticing that its *instructions* moved is not. The rule above landed on `main` twenty-two minutes before "Recover from an expired sign-in instead of failing silently" (pull request 71) merged, and that session finished without ever reading it — every finding fixed and pushed, every thread still unanswered.

## Where things are decided

| Document | What it settles |
|---|---|
| `docs/functional-definition.md` | what the product is |
| `docs/architecture.md` | how it is built |
| `docs/testing-strategy.md` | what counts as proof it works |
| `docs/deployment.md` | where it runs and how it gets there |
| `docs/ideas.md` | unscheduled ideas, deliberately not scheduled |

Options documents (`docs/*-options.md`) record integration research. `poc/` holds proofs of concept and is outside the workspace, so it never runs in CI.

**Cite a section by its name, never by its number alone.** "The bootstrap runbook (deployment §7)" tells the reader what is being pointed at; "deployment §7" makes them go and look it up before they can even judge whether it is relevant, and in conversation it says nothing at all. The numbers are useful as locators inside the documents, which cross-reference each other constantly — they are not a shorthand anyone can read. The same applies to issue numbers: name the issue, then give the number.

**When you add or change a rule, apply it across the whole change mechanically.** Search for every instance rather than judging them one at a time. Four of the thirteen review findings on the pull request that added the rule above were that same rule, broken elsewhere in the same change — each one survived because it was looked at individually and seemed defensible, and one sweep missed a whole class because grepping for `§` structurally cannot find the issue numbers the rule also covers. The same holds when a fact stops being true: search for the *claim*, not the file you happen to have open. "The browser tier runs against the `pnpm dev` pair" was corrected three times, in three files, before anyone searched for the sentence itself.

**Counts and enumerations are claims as much as sentences are.** Adding a tenth feature area left the same “nine areas” claim standing in three places across two documents. Review found the pair in the file it happened to be reading; the third, the registry's own comment, surfaced only from searching for the sentence.

**Write file content with `Write` and `Edit`, and keep the shell for commands.** A heredoc into a script into a TypeScript string is three layers of escaping, and `\r\n`, a lone backslash and a null byte survive none of them. Two source files were mangled that way in one session, both badly enough that `grep` reported them as binary, and the script written to repair the second was broken by the same escaping on its own Windows path. The file tools take content exactly as written.
