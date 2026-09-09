---
description: Implement one GitHub issue end to end, to this repository's process and definition of done
argument-hint: <issue-number> [extra instructions]
---

Implement exactly one GitHub issue in `michaelvanhoutte/cockpit`, end to end.

Arguments: `$ARGUMENTS`. The first token is the issue number; anything after it is an instruction for this run and overrides the defaults below where they conflict.

CLAUDE.md is already loaded into this session and governs how this repository is worked — the writing rules, when to scope, working-in-parallel tools, the testing rules that get skipped most, and the review-findings flow. This command only sequences what CLAUDE.md and its skills already state, in the order a run actually needs them. Never restate a rule here that already lives there — fix it there instead.

1. **Confirm the issue is live.** `gh issue view <number> --json state,title,assignees,body` plus `gh pr list --state all --search <number> --json number,title,state`, per "Check the issue is still open, and unclaimed" under **Scoping new work**. Read the issue's comments too — they routinely carry the decision the body doesn't.
2. **Scope it.** Run the `scoping` skill before writing anything, per the same section.
3. **Build**, following the conventions already in the code it touches — `packages/shared` is the contract.
4. **Test**, per the `testing` skill. If the capability needs a tier that doesn't exist yet, building it is part of this issue, not a follow-up.
5. **Prove it runs**, per **Tests**: start it with `pnpm dev` and drive the changed behaviour in a real browser. Staging only ever carries what has already merged to `main`, so a branch's own changes are never there to see — verify locally, signing in through the stub issuer `pnpm dev` prints rather than a deployed environment's own Google sign-in. Write the walk into the pull request body as you go.
6. **Review yourself before pushing**: `/code-review xhigh` and `/security-review` on the diff, per **Review findings**.
7. **Ship**, per **Review findings**: draft, ready, wait for checks, answer every thread.
8. **Report honestly.** Test results as they actually came out; anything skipped or narrowed, and why.

Mark a chapter at each phase boundary (scoping settled, build done, review findings in, browser pass done), per **Working in parallel**.
