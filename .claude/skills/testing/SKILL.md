---
name: testing
description: Cockpit's binding rules for tests - which level a test goes at, where it lives, how it is named and shaped, and what must be run before claiming something works. Use whenever writing, moving, reviewing or deleting a test; when adding logic, fixing a bug or finishing a capability (tests ship in the same change); when drafting a statement list for an issue; and before reporting that a change works.
---

# Testing in Cockpit

**This file is complete on its own. Do not open the strategy document to write a test.** Every binding rule is restated here; [docs/testing-strategy.md](../../../docs/testing-strategy.md) holds the reasoning behind them and is the authoritative version of record. Open it only to change a rule, to settle a case this file genuinely does not decide, or when asked why a rule exists - and when it turns out to contradict this file, the document wins and this file is the thing to fix.

The premise: writing tests is nearly free, running them is not. Every test is a permanent tax on every future change. Cheap to write does not mean cheap to own.

## Pick the level: lowest that can prove the behaviour

Ask in order, stop at the first yes:

1. Can a **unit test** prove it? Write a unit test.
2. Does it need a real vertical dependency (real DB query, real schema, real serialization)? Write an **integration test** covering *only* the part the unit test could not.
3. Does it only exist when services talk to each other? Write a **system test** covering *only* the cross-service wiring. (Cockpit has one service today, so this tier does not exist yet - see "This repo, today".)
4. User-visible? Same ladder on the frontend: frontend unit → frontend + its own backend → end-to-end browser.

**Duplicating coverage upward is a violation.** If a unit test proves the calculation, the integration test proves only that the calculation is reachable and wired correctly, never that it is correct.

The reason for escalating must name what stops a lower level proving it:

| Bad reason | Good reason |
|---|---|
| Integration, because it is integration-like | Integration, because a panel's contents are a query, so this only holds against a real database |
| End to end, because it is user-facing | End to end, because the drag only exists in a browser |

Escalating because a unit test would prove nothing is the rule working, not an exception to it.

## Dependency restrictions per level

Two directions. **Vertical** = infrastructure this service owns (its DB, queue, storage). **Horizontal** = anything crossing a service boundary (other services, Slack/Notion/Teams/WhatsApp/Mail, the network).

| Level | Vertical | Horizontal | Proves |
|---|---|---|---|
| L1 unit | none real | none real | logic: calculations, branching, validation, error paths, edge cases |
| L2 integration | real | forbidden, fakes only | the logic works against this service's own real infrastructure |
| L3 system | real | real | services wired together work at the API level; backend only, no browser |
| F1 frontend unit | none real (replace API client, stores, router, timers) | none real | component / view-model logic |
| F2 frontend + own backend | its own service's backend, or a faithful local fake | nothing else | frontend and its backend agree: contracts, payloads, errors, loading states |
| F3 end-to-end | everything real | everything real | a user-facing capability works with the whole thing tied together |

**L1/F1 may not touch:** filesystem, network, database, the clock (inject time), environment variables, global state, or another process. If a test needs one, it is not a unit test - move it up a level or refactor so the logic is testable in isolation.

**Mocking discipline (L1/F1).** "No real dependencies" is not "mock everything":

- Prefer pure units over mocks. Code that needs heavy mocking is a design smell to fix, not a mocking exercise to complete.
- Where a boundary must be replaced, replace it at the edge (the API client, the repository, the clock), not deep inside the code under test.
- **Assert on outcomes, not interactions** - what the code produced (return value, resulting state, emitted error), not the sequence of calls it made. Choreographing mock calls is brittle, survives real breakage, and is a violation.

**Third parties.** Never at L1/F1. At L2/F2 and per-change L3/F3, use local fakes or fixtures recorded from real responses (not hand-invented shapes), checked into the repo. Live contract tests run on a schedule only, against the real APIs, purely to verify the fixtures still match reality. A failing contract test makes updating the fixture priority work.

## Where the test goes

Folders per level, inside the package that owns them. A folder is a boundary that can be policed; filenames are not.

```
apps/api/tests/{unit,integration}/
apps/web/tests/{unit,service}/
packages/shared/tests/unit/
packages/connectors/*/tests/{unit,contract}/    when connectors land
tests/e2e/                                       repo root - belongs to no package
```

Mirror the source layout inside `unit/` so an untested module stays visible. Levels with no reason to exist yet stay absent - never create an empty folder to populate the taxonomy.

## Name it after the product, not the mechanism

The **outer describe is the product concept as a dotted name**; the block inside it is the rule in product language.

```ts
describe('action.assign', () => {
  describe('a panel shows exactly the actions assigned to it', () => {
    // cases
  });
});
```

The runner then prints the statement list itself: `action.assign > a panel shows exactly the actions assigned to it > an action deleted > does not appear in panel A`. Nothing is stored separately, so nothing goes stale.

A rule is **one behaviour in product language and one test body**; its cases are a table inside that body. Never one test per statement.

| Bad rule | Why |
|---|---|
| `commandService` dedupes by `commandId` | names the implementation, unreadable as intent |
| The panel contents query filters on assignment and excludes deleted rows | true, and still a mechanism statement |
| Actions work correctly | not falsifiable |

Good: *A panel shows exactly the actions assigned to it.* *A repeated command changes nothing the second time.* *An invalid command is rejected and writes nothing.*

Prefer a rule whose **table grows as the product grows**: one "an invalid command is rejected and writes nothing" with rows, not one rule per validation. On the frontend, "a command that fails puts the screen back" absorbs every command.

**Frontend rules are about the UI's own behaviour and its wiring, never a restatement of a backend rule.** Bad: a browser test for "removing an action from a panel leaves it on the other panels". Good: "the remove control sends a remove for this panel" - plus, separately, one browser walk per capability.

The shape - one body, tables as data, so adding a situation is one line:

```ts
describe.each(situations)('an action $name', (s) => {
  // arrange from s
  it.each(places)('$verb in $where', async ({ read, expected }) => {
    expect((await read()).some(a => a.id === ws.lastActionId)).toBe(expected);
  });
});
```

## Mandatory coverage

1. **Every capability has at least one frontend test** (F3, or F2 where F3 genuinely cannot reach it) proving it works for a user. Unit and integration tests never count as proof that a capability works.
2. **Every bug fix gets a regression test at the lowest level that reproduces the bug.**
3. **New logic ships with L1/F1 tests in the same change.** Never a follow-up task.
4. A rule that is agreed but not yet built is `describe.todo` / `it.todo` in the real test file at the real level. **No todo may survive a merge.** Removing a todo requires, in the same diff, either the test appearing or a comment saying we chose not to test it. A rule blocked on an unanswered product question becomes an issue, not a todo.
5. **A test with no assertion is a failure, not a pass.** When a rule is written, see the whole table go red once before the implementation lands, and say so in the pull request.

Tests are for confidence, not for covering everything. A case no plausible implementation could get wrong is padding, and padding makes a list unreviewable. Cut a case only when it has **no distinct path** (same data, same query, same parameters) or is **already exercised** (something else runs that code and would go red if it broke). "It is obvious" and "it would be hard to get wrong" are not reasons on their own. Do not over-prune: if there is a distinct query, branch or decision behind a case, keep it however obvious it looks.

## Definition of done - non-negotiable

Do not claim something works until all of these hold:

1. **Fast tiers (L1, L2, F1, F2) run in full and pass.** No selection, no "only the tests near my change".
2. **Slow tiers (L3, F3): every test covering the capabilities touched by the change.** Select by capability, include when in doubt. "I selected too narrowly" is never a valid explanation for a broken merge.
3. **The application was actually started and the changed behaviour exercised.** Green unit and integration tests are never evidence that the app runs - the failure mode this exists to prevent is an all-green suite over an app that crashes on startup. Use the F3 suite where one covers it, otherwise start the app (commands under "This repo, today") and drive it in the browser.
4. **Results reported faithfully.** Failures quoted with their output. Any tier skipped or narrowed stated, with why. Never a success claim over a partial run without saying what was left out.
5. **New tests sit at the right level and respect the dependency restrictions above.** A misplaced test gets moved, not grandfathered in.

If step 3 reveals a failure the tests missed, add the missing test before finishing - the gap in the pyramid is itself a bug.

**Budget.** The fast tiers together stay under 5 minutes locally, L1+F1 in seconds. Exceeding it makes restoring it priority work (push tests down the pyramid, delete redundant ones, parallelize) - never resolved by skipping runs. Keep L3/F3 few and thin: before adding one, ask what it proves that nothing below can. If the answer is nothing, do not add it.

**Flakiness.** Never retry-to-green; never weaken assertions, widen tolerances or add sleeps. Fix immediately or quarantine with an owner and an open bug; a test that stays quarantined is deleted.

## This repo, today

Verify against `package.json` before relying on any of this - the section goes stale.

- **One service**, so there is no horizontal boundary except third parties: L2 and L3 collapse, and the API-in-process tests against a real local D1 are the backend tests. L3 becomes a real tier the day a second service exists.
- **Runner:** Vitest (`apps/api`, `packages/shared`). No browser runner yet, so F3 is done manually through the browser tooling until one lands.
- **`pnpm test`** runs `-r test` across packages. Per-level scripts (`test:unit`, `test:integration`, `test:f-unit`, `test:f-service`, `test:e2e`, `test:contract`, plus `test:fast` and `test:all`) are the target shape; add the one you need rather than folding a new level into an existing command.
- **The per-level folders under "Where the test goes" do not all exist yet**, and two tests still sit in the source tree ([apps/api/src/domain/items.test.ts](../../../apps/api/src/domain/items.test.ts), [packages/shared/src/shared.test.ts](../../../packages/shared/src/shared.test.ts)). Create the folder when adding the first test of that level; move the strays when touching them.
- **Starting the app** (needed by the definition of done): `pnpm dev:api` on :8787 and `pnpm dev:web` on :5173, after `pnpm build` and the one-time `db:migrate:local` / `db:seed:local`. Full sequence in [readme.md](../../../readme.md).

## Reviewing tests

Reject: tests at the wrong level; coverage duplicated upward; L1/F1 tests with real dependencies or interaction-choreography assertions; L2/F2 tests with horizontal dependencies; a capability with no frontend test; a test named after a mechanism rather than the product; a surviving todo; a "done" claim not backed by the definition of done.

Prefer making a violation impossible over catching it in review: no network or filesystem in the unit runner, lint rules banning API-client imports under unit folders, a CI job per level, and the time budget checked in CI.

## When drafting a statement list for an issue

Read [references/statement-lists.md](references/statement-lists.md) - the passes in order, the collapsing step agents skip, the pruning criterion, and the output shape. Worked example: [docs/statements-issue-36-experiment.md](../../../docs/statements-issue-36-experiment.md).
