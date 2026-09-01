import { defineConfig, devices } from '@playwright/test';

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
 *    cannot disturb, or be disturbed by, the app you are clicking through on
 *    :5173.
 *    Same one-origin shape as production either way: Vite proxies /v1, /health
 *    and /ingress to the Worker, so the browser sees a single origin.
 *
 *    Not identical to production: no service worker (vite-plugin-pwa stays off
 *    in dev), unbundled modules, and Vite's own SPA fallback rather than the
 *    Worker's `run_worker_first` routing. Those three are all-or-nothing
 *    failures rather than per-feature ones, and until the suite can run against
 *    a deployment they are covered by looking at the preview before promoting.
 *    Running it against a deployment needs an Access service token *and* a way
 *    to keep test data out of real data. The second is now possible - accounts
 *    and sign-in arrived with "Sign in by picking a name, each user in their own
 *    account" (issue 86), so the suite can have an account of its own - but
 *    nothing here does it yet: that is "Run the F3 suite against a deployed
 *    environment, as its own account" (issue 64), which has to provision that
 *    account and sign in as it. Until then E2E_BASE_URL starts no server and
 *    points the specs at a URL, which is enough to try it by hand but is
 *    deliberately not wired into CI.
 * 2. WHICH SCREENS. Every spec runs under both projects, because "the actions
 *    work on that device" is a claim about each device, not about the code.
 *    Both are Chromium — this is a viewport and input matrix, not a browser
 *    matrix. A test that only makes sense on one device (a swipe, a
 *    hover-revealed control) belongs in its own spec guarded by `isMobile`,
 *    not in a third project.
 */

// Must agree with scripts/e2e-stack.mjs's WEB_PORT.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5273';
const drivingLocalStack = !process.env.E2E_BASE_URL;
const usingAccessToken = !!(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET);

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
  // exactly what I put in it" a race rather than an assertion. Affordable
  // precisely because F3 is kept few and thin — the run is seconds, against a
  // stack that takes about nine to boot. If it ever stops being affordable,
  // the fix is a stack per worker, not parallelism over shared state.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL,
    // Kept on failure only: enough to diagnose "it looked wrong" without the
    // cost — or the cross-machine baseline problem — of pixel snapshots, which
    // this tier deliberately does not do.
    //
    // Except when this run carries an Access service token, where the trace is
    // turned off entirely. A trace records every request's headers verbatim,
    // the credentialed run is the one whose failures get uploaded as a CI
    // artifact, and the two together would publish CF-Access-Client-Secret as a
    // downloadable file for anyone who can read the run. Losing the trace makes
    // a failed credentialed run harder to diagnose; that is the right way round,
    // and screenshots (which carry no headers) still survive.
    trace: usingAccessToken ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Cloudflare Access fronts every deployed environment (secrets and access,
    // docs/deployment.md §6), so a preview run needs a service token or it gets
    // the login page instead of the app. Absent locally, where there is no Access in front.
    ...(usingAccessToken
      ? {
          extraHTTPHeaders: {
            'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID!,
            'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET!,
          },
        }
      : {}),
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
