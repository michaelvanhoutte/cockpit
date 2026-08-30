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
