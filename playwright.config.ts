import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { isLinkedWorktree, portsFor } from './scripts/lib/ports.mjs';

/**
 * F3, the end-to-end tier — the level definitions and the directory
 * conventions of docs/testing-strategy.md (§2, §9). Lives at the repo root
 * because it belongs to no package: it drives `apps/web` and `apps/api`
 * together, and `tools/test-explorer` reads `tests/e2e/` at the root as the F3
 * column (its columns table, docs/test-explorer-spec.md §4.2). The frontend
 * test framework issue (#41, "build the F1 and F3 tiers for apps/web") proposed
 * `apps/web/tests/e2e/`; the explorer, which landed later, maps
 * `apps/web/tests/<x>/` to F1/F2 and nothing else, so a suite there would be
 * silently uncounted. Root wins.
 *
 * Two things this configuration decides, both recorded because both were
 * argued:
 *
 * 1. WHAT IT RUNS AGAINST. Its own stack, on its own ports, against storage
 *    rebuilt before every run (scripts/e2e-stack.mjs) — never the one
 *    `pnpm dev` uses. So a run starts from the same place every time and
 *    cannot disturb, or be disturbed by, the app you are clicking through.
 *    Same one-origin shape as production either way: Vite proxies the
 *    Worker's own prefixes to it (`server.proxy` in apps/web/vite.config.ts),
 *    so the browser sees a single origin.
 *
 *    Not identical to production: no service worker (vite-plugin-pwa stays off
 *    in dev), unbundled modules, and Vite's own SPA fallback rather than the
 *    Worker's `run_worker_first` routing. Those three are all-or-nothing
 *    failures rather than per-feature ones, and until the suite can run against
 *    a deployment they are covered by looking at staging before promoting.
 *    The one exception is the update path: tests/e2e/updating.test.ts opens the
 *    production build in a real browser holding a real service worker, from a
 *    server of its own that decides when a deploy lands, so every other walk
 *    still runs with none.
 *    Running it against a deployment needs a way to keep test data out of real
 *    data, which is now possible - accounts and sign-in arrived with "Sign in
 *    by picking a name, each user in their own account" (issue 86), so the
 *    suite can have an account of its own - but nothing here does it yet: that
 *    is "Run the F3 suite against a deployed environment, as its own account"
 *    (issue 64), which has to provision that account and sign in as it. Until
 *    then E2E_BASE_URL starts no server and points the specs at a URL, which is
 *    enough to try it by hand but is deliberately not wired into CI.
 * 2. WHICH SCREENS. Every spec runs under both projects, because "the actions
 *    work on that device" is a claim about each device, not about the code.
 *    Both are Chromium — this is a viewport and input matrix, not a browser
 *    matrix. A test that only makes sense on one device (a swipe, a
 *    hover-revealed control) belongs in its own spec guarded by `isMobile`,
 *    not in a third project.
 */

// Asked of the same function scripts/e2e-stack.mjs asks, rather than holding a
// copy of the number: the port depends on which checkout this is
// (scripts/lib/ports.mjs), so a written-down one could only be right for the
// primary checkout and would silently point every worktree's run at a server
// that is not the one it just started.
// `__dirname`, not `import.meta.url`: Playwright transpiles this config to
// CommonJS - the root package.json declares no `"type": "module"` - so
// `import.meta` is a syntax error here however the file is written. This is the
// repo root, since the config lives at it.
//
// The same transpiling is why the import above needs Node 22.12 or newer:
// requiring an ES module from CommonJS was unflagged in that release, and this
// config is the one place in the repository that does it. The root
// package.json's `engines` asks for a later Node than that, for a reason of its
// own, so this constraint is satisfied without being the binding one.
const root = __dirname;
// A path rather than an import: this file is loaded as CommonJS, the reporter is an ES module.
const playwrightSessionReporter = join(root, 'scripts', 'lib', 'playwright-session-reporter.mjs');
const ports = portsFor(root, { linked: isLinkedWorktree(root), env: process.env });
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${ports.e2eWeb}`;
const drivingLocalStack = !process.env.E2E_BASE_URL;
// Where the Harness Monitor's walk finds the second Worker the local stack
// starts. Set here, before the workers are spawned, so they inherit it; absent
// against a deployment, which has no seeding route, and the walk then says so.
if (drivingLocalStack) process.env.E2E_HARNESS_MONITOR_URL = `http://localhost:${ports.e2eHarnessMonitor}`;

/**
 * The phone profile is a real handset's, not a round number: Michael's is a
 * Galaxy A57, and Playwright's closest registry entry is the A55 of the same
 * line — 1080 physical pixels at a device pixel ratio of 2.25, so the page is
 * laid out in 480 CSS pixels. Worth knowing before reading that as "roomy":
 * Samsung's S line divides 1080 by 3 instead and reports 360, and the Display
 * size accessibility setting narrows it further, so 480 is this device, not
 * the floor. Add `Galaxy S24` as a third project the day the narrow end needs
 * proving; do not silently retune this one, because then it stops being a
 * device anybody actually holds.
 */
const phone = devices['Galaxy A55'];
const desktop = devices['Desktop Chrome'];

export default defineConfig({
  testDir: 'tests/e2e',
  // The explorer only walks `*.test.ts` under tests/e2e (analyze/index.js's
  // walkTestFiles), so Playwright's `.spec.ts` default would leave the F3
  // column reading zero however many tests were written.
  testMatch: '**/*.test.ts',

  // The flakiness policy is "never retry-to-green", and a retry count is
  // exactly that mechanised. A failure here means something is broken or the
  // test is; both need diagnosing, not re-running.
  retries: 0,

  // One worker, so the tier's whole point survives: every spec shares one
  // database, and two specs capturing at once would make "the inbox holds
  // exactly what I put in it" a race rather than an assertion. CI runs the tier
  // as four shards (E2E_SHARD, scripts/ci-e2e.mjs), each on its own runner with
  // its own stack, so this is one worker per stack and the walks still run
  // serially within it. The fix for a slower tier is another shard, not
  // parallelism over shared state.
  workers: 1,
  // Only so `--shard` deals individual walks rather than whole spec files, which
  // would leave the shards uneven. A walk therefore never relies on an earlier
  // one in its file having run: that is a bug under the flakiness policy.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The last records the run on the branch's session record, where it has one.
  reporter: process.env.CI ? [['github'], ['list'], [playwrightSessionReporter]] : [['list'], [playwrightSessionReporter]],

  use: {
    baseURL,
    // Kept on failure only: enough to diagnose "it looked wrong" without the
    // cost — or the cross-machine baseline problem — of pixel snapshots, which
    // this tier deliberately does not do.
    //
    // A trace records every request's headers verbatim and failed runs are
    // uploaded as a CI artifact, so anything that ever puts a credential on
    // these requests has to turn this off in the same change.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'desktop', use: { ...desktop } },
    { name: 'phone', use: { ...phone } },
  ],

  ...(drivingLocalStack
    ? {
        webServer: {
          command: 'node scripts/e2e-stack.mjs',
          url: baseURL,
          // Never reuse. The point of the stack is the database it rebuilds on
          // the way up, and attaching to one already running would silently
          // inherit whatever the last run left behind — the exact
          // order-dependence this tier is arranged to avoid. A stray listener
          // on the port fails the run instead, which is the honest outcome.
          reuseExistingServer: false,
          // Generous because a first run may build the database template and
          // the SPA before Vite listens.
          timeout: 180_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }
    : {}),
});
