# Third parties

Open this for a test that touches an outside service or a Claude prompt. The rules every test follows are in [SKILL.md](../SKILL.md). Third-party APIs are the hardest horizontal dependency: their sandboxes are often missing, slow, rate-limited or flaky.

## The three rules

1. **L1/F1: a third party never appears.**
2. **L2/F2 and per-change L3/F3 use local fakes or fixtures recorded from real responses**, never hand-invented shapes, checked into the repository. Fake at the *network* boundary, by replacing `fetch`, so the application makes its own request through its own client (`apps/api/tests/integration/issuer.ts`, and the model in `apps/api/tests/integration/http/note-cleanup.test.ts`). A connector's own code takes its `fetch` handed in, so its tests reach no network.
3. **A small live contract suite checks the fixtures still match reality**, never per change: when a prompt it holds changes, weekly, and by hand. A failure makes updating the fixture priority work, and is never fixed by running it again.

Rule 3 is what makes the first two safe: without it every level stays green against a fake of Slack while real Slack has changed.

**List every outside service in `scripts/outside-services.json`**, with its contract suite in `suite` or a `gap` saying why there is none yet, since a service nobody listed has no rule 3 at all. `pnpm test:scripts` fails on an outside `https://` host in product or Harness Monitor source that no entry claims (`scripts/lib/outside-services.test.mjs`). A service reached through an SDK or a binding has no host to scan, so list it by hand.

## Where the live tier lives

| Package | Folder | Config | What it asks |
|---|---|---|---|
| `@cockpit/api` | `apps/api/tests/contract/` | `apps/api/vitest.contract.config.ts` | the Claude API, one call per prompt; the free suites |
| `@cockpit/connector-teams` | `packages/connectors/teams/tests/contract/` | `packages/connectors/teams/vitest.contract.config.ts` | whether Microsoft still publishes the signing keys, issuer and algorithm the connector checks a saved message against; no credential, the keys being public |
| other connectors | `packages/connectors/*/tests/contract/` | their own `vitest.contract.config.ts` | their recorded answers against the real service |

Run it with `pnpm --filter <package> test:contract`. **It is excluded from the config every other tier runs under**, not left to a naming convention: `pnpm test` is `vitest run` over everything under `tests/`, and a tier that spends real money must not be reachable by an ordinary test command. It is in neither `test:fast` nor `test:all`. CI runs it from `.github/workflows/contract.yml` on a pull request that touches the AI layer, weekly, and on demand.

## A model is checked twice, at two prices

A model's answer differs every time, so it is not an API. The tier arrived with the Claude API ("Clean up a captured note into a clear title and a fuller message", issue 296), which settled this rule and the credential rules below for every later third party.

- **CI asks each prompt one question.** `apps/api/tests/contract/one-call.test.ts` makes one call per prompt on an ordinary note and asserts only that the answer parses into the prompt's result, so a red check means the API or the parsing moved, never the model's judgement. A prompt added or moved to a new version needs its check there; `pnpm test:scripts` fails without it. A run naming nothing (a pull request, the weekly run, a bare run by hand) makes that one call per prompt and runs the free suites; `scripts/lib/contract-selection.mjs` decides which files that is, so the weekly run carries the Claude key without relying on a file list to stay off the model.
- **What the prompt was written to get is a behaviour suite per prompt** (`<prompt>.vN.test.ts`): a property such as the language it answers in, or that it invents no name, date or number the note did not carry, preferably measured failing before the prompt existed. It costs about a hundred calls and can only drift on our side when the prompt changes, so **it runs only when named**: whoever changes a prompt runs its suite locally before pushing (`pnpm --filter @cockpit/api test:contract clean-up-a-note`), and the pull request shows that run among its recorded local runs. Nothing in CI gates on it.

## Credentials

- **A contract run with no credential is red, never skipped**, because a skipped tier reads green from outside, the same silent failure rule 3 exists to close.
- **A Claude key with no `USAGE_RECORDING_TOKEN` is red before any call too.** Every Claude call a contract run makes is recorded in production, as CI with its run and pull request or as local with its branch ("Record every Claude call a contract run makes, as CI or local", issue 1459), and a call that would leave no row is not made.
- **Every tier below the contract one pins each credential empty**, because a credential on disk reaches every tier. `apps/api/.dev.vars` is read by the workers pool *and* by the browser tier's own Wrangler, so a real key left there for `pnpm dev` silently arms both: the backend suite spends money against the real API, and walks assert on text a model has since rewritten (`filing.test.ts` failed on "Chase the invoice…" having become "Chase invoice…"). Both are pinned where they start (`apps/api/vitest.config.ts`, `scripts/e2e-stack.mjs`); the next third party needs the same two lines.
