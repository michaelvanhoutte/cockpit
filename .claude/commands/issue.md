---
description: Implement one GitHub issue end to end, to this repository's process and definition of done
argument-hint: <issue-number> [extra instructions]
---

Implement exactly one GitHub issue in `michaelvanhoutte/cockpit`, end to end.

Arguments: `$ARGUMENTS`. The first token is the issue number; anything after it is an instruction for this run and overrides the defaults below where they conflict.

CLAUDE.md is already loaded into this session and governs how this repository is worked — the writing rules, when to scope, working-in-parallel tools, the testing rules that get skipped most, and the review-findings flow. This command only sequences what CLAUDE.md and its skills already state, in the order a run actually needs them. Never restate a rule here that already lives there — fix it there instead.

1. **Confirm the issue is live.** `gh issue view <number> --json state,title,assignees,body,comments` plus `gh pr list --state all --search <number> --json number,title,state`, per "Check the issue is still open, and unclaimed" under **Scoping new work**. Read the comments — they routinely carry the decision the body doesn't.
2. **Ask once, before building anything: merge automatically once a pull request is clean, or hold for me to merge by hand?** My answer depends on what else is running, so ask every time rather than assuming. Carry the answer through the rest of this run, including every unit if scoping splits the work into several — do not ask again per unit.
3. **Scope it.** A **scoped** issue already has a populated **Test cases** section carrying a statement list; an issue without one hasn't been through scoping yet. Where it's scoped, sharpen only what's still genuinely fuzzy. Where it isn't, run the `scoping` skill in full before writing anything, per **Scoping new work**. If scoping sizes this as several units, build and ship them one at a time in dependency order — see step 8 on what "ship" requires before the next unit's build starts.
4. If the issue (or the unit being built) names a recommended model, do steps 4–7 inside an `Agent` tool call using that model override rather than in this session — the calling session stays whatever it started as; otherwise continue here. No issue names one yet: "Recommend a model per sliced unit of work when scoping" (issue 275) is what would add that field. **Build**, following the conventions already in the code it touches — `packages/shared` is the contract.
5. **Test**, per the `testing` skill. If the capability needs a tier that doesn't exist yet, building it is part of this issue, not a follow-up.
6. **Prove it runs**, per **Tests**: start it with `pnpm dev` and drive the changed behaviour in a real browser. Staging only ever carries what has already merged to `main`, so a branch's own changes are never there to see — verify locally, signing in through the stub issuer `pnpm dev` prints rather than a deployed environment's own Google sign-in. Write the walk into the pull request body as you go.
7. **Review yourself before pushing**: `/code-review xhigh` and `/security-review` on the diff, per **Review findings**.
8. **Ship**, per **Review findings**: draft, ready, wait for checks, answer every thread. Then, per the answer from step 2: merge it yourself, or say plainly that it's ready and waiting for a human to merge. **A unit isn't finished until its pull request is actually merged** — checks green and threads resolved is not the finish line. Where scoping split the work into several units, the next one's build does not start until this one is merged into `main`; build it against the merged result, not a stacked branch. That next unit repeats steps 4–8 — not 1–3, since the issue is already confirmed live and scoped, and step 2's answer already carries forward.
9. **Report honestly.** Test results as they actually came out; anything skipped or narrowed, and why.

Mark a chapter at each phase boundary, per **Working in parallel**.
