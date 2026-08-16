---
description: Implement one GitHub issue end to end, to this repository's testing strategy and definition of done
argument-hint: <issue-number> [extra instructions]
---

Implement exactly one GitHub issue in `michaelvanhoutte/cockpit`, end to end, to the standard below.

Arguments: `$ARGUMENTS`. The first token is the issue number. Anything after it is an instruction from me for this run and overrides the defaults below where they conflict.

## 0. Ground rules

- **One issue, one branch, one PR.** Branch `claude/issue-<number>-<slug>` off the latest `origin/main`. Never commit to `main`.
- **Scope is the issue.** Adjacent problems you spot get reported at the end (and offered as new issues), not fixed in this branch. The exception is anything the issue cannot work without, which you call out explicitly in the PR.
- **The recorded decisions win.** `docs/functional-definition.md` (the what), `docs/architecture.md` (the how), `docs/testing-strategy.md` (the proof), `docs/deployment.md` (the where). If the issue contradicts one of them, stop and ask me. If implementing it changes a decision, amend the document *with the reasoning*, per architecture §11.
- **Ask instead of inventing.** If a functional detail is genuinely underspecified (issue #30's "the exact number of colors depends on the CSS setup" is the archetype), ask me with a concrete recommendation rather than guessing. Do not ask about things you can decide from the docs or the code.
- **Never**: weaken, skip, `.skip`, or delete a test to get green; re-run a failing test hoping for green (testing-strategy §8); claim something works without having run it; commit secrets or real tokens.

## 1. Understand

1. Read the issue **and all its comments** (`issue_read` with `get` and `get_comments`). Comments frequently carry the decision that the body does not.
2. Check prerequisites. Issues #30 to #40 form a dependency chain. If this issue depends on work that is not merged into `main` yet, say so and stop rather than building on a branch that does not exist.
3. Read the relevant parts of the four docs, plus the code the change touches. Use the `Explore` subagent for the codebase sweep so the mapping does not eat this context.
4. Restate, in three or four lines: what the user-visible capability is, which existing code it touches, and which recorded decisions constrain it.

## 2. Plan before code

Produce a short plan covering:

- The **capabilities** (user-facing features per the functional definition) this change adds or changes. This list drives the mandatory frontend tests in testing-strategy §5.1: every capability needs at least one F3 test (or F2 where F3 genuinely cannot reach it).
- The **test plan per level**, using the §1 decision procedure: what is proven at L1/F1, what genuinely needs L2/F2, and the thin F3 walk of the happy path. State what you are deliberately *not* testing at a higher level, so upward duplication is a visible choice rather than an accident.
- Contract changes (`packages/shared`), schema changes plus migration, and API routes.
- Anything that touches `auth/`, tenancy, or connector credentials, which gets the strictest review (architecture §8).

For a substantial issue, use the `Plan` subagent to draft this. Present the plan, then continue without waiting unless it contains an open question for me.

## 3. Build

Follow the existing code's conventions rather than introducing new ones. Binding ones worth repeating: `packages/shared` is the only place a cross-boundary shape is defined, mutations are commands (architecture §4.3), every row carries `tenant_id`, and workspace scoping is enforced server-side, never only in the UI (§4.2, §8).

## 4. Test

Testing-strategy `docs/testing-strategy.md` is authoritative and binding. Read it before writing tests. On top of it, for this repository as it stands today:

- **The frontend test tiers do not exist yet.** `apps/web` has no test runner, and `pnpm test` covers only `@cockpit/api` and `@cockpit/shared`. If this issue touches the UI, standing up the tier is part of this issue, not a follow-up: add the runner (Vitest plus Testing Library for F1, Playwright for F3), place tests per §9, add the per-level `test:*` scripts, wire them into `pnpm test`, and add the matching CI job in `.github/workflows/ci.yml` (architecture §9.1 asks for one job per tier so a misplaced test is visible). Do this the smallest way that works, and do not build tiers the repo has no use for yet (§2, "levels are roles, not mandatory folders").
- **Run the fast tiers in full** (§6.1). No test selection, no "only the tests near my change".
- Run the slow tiers covering every capability you touched, per §6.1.
- Check the fast-tier runtime against the 5 minute budget (§7) and report it if you added meaningfully to it.
- New logic ships with its tests in the same change; a bug fix ships with a regression test at the lowest level that reproduces the bug (§5).

## 5. Prove it actually runs

Green tests are not evidence that the app runs (§6.2). Required, every time:

1. Start it locally: `pnpm build` once, then `pnpm dev:api` (port 8787) and `pnpm dev:web` (port 5173) in the background, with local D1 migrated and seeded (`pnpm --filter @cockpit/api db:migrate:local` and `db:seed:local`).
2. Drive the changed capability **in a real browser** with Playwright against `http://localhost:5173`. Chromium is preinstalled here (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), so never run `playwright install`.
3. Take screenshots of the changed capability, at desktop width and at a phone viewport, and attach or describe them in the PR. Mobile is a first-class target for this product.
4. Watch the browser console and the Worker log while you do it. New errors or warnings are findings, not noise.
5. **Do not verify on the deployed preview.** All three deployed environments sit behind Cloudflare Access, so the preview URL is not reachable from this session. Local is the verification surface.
6. If exercising it by hand reveals something every test missed, add the missing test before finishing (§6, closing rule): the hole in the pyramid is itself a bug.

## 6. Review yourself, in fresh eyes

Automated PR review and security scanning are not built yet (issues #27 and #28), so they happen here. Once those workflows land, drop this section.

1. Run `/code-review` on the diff.
2. Run `/security-review` on the diff. Beyond whatever it reports, check this repository's own sensitive surface by hand: workspace and tenant scoping enforced server-side, Zod validation at every boundary, no token or message content logged, no secret in the repo, anything under `auth/`.
3. Check the performance gates in architecture §7 if you touched the client: the compressed initial JS bundle stays under 200KB, and heavy dependencies are lazy-loaded or rejected.
4. Fix what the reviews find, or state plainly why a finding is wrong. Re-run the fast tiers after fixing.
5. Have a **subagent with fresh context** re-read the final diff against the issue's acceptance criteria and testing-strategy §6, and report anything unmet. A self-review inside the context that wrote the code is the weakest review available.

## 7. Ship

- Conventional commit messages, describing the reasoning and not only the change.
- `git push -u origin <branch>`.
- Open a PR that closes the issue (`Closes #<number>`), following any repository PR template. The body states: what changed and why, which recorded decisions it rests on or amends, the tests added per level and **why each is at that level**, the evidence from section 5 (what you clicked, what you saw), and anything skipped or narrowed with the reason.
- Update `readme.md` or the docs if the layout, the commands, or a decision changed.
- Drive CI to green. A red check is yours until it is green or you have explained in the PR why it is not yours.

## 8. Report honestly

Report test results faithfully (§6.3): if something failed, show the output; if a tier was skipped or narrowed, say so and why. "It should work" is not a result. If you could not finish part of the issue, finish everything else and state exactly what is left and why.
