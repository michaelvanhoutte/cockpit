import { defineConfig, devices } from '@playwright/test';

/**
 * F3, the end-to-end tier (docs/testing-strategy.md §2, §9). Lives at the repo
 * root because it belongs to no package: it drives `apps/web` and `apps/api`
 * together, and `tools/test-explorer` reads `tests/e2e/` at the root as the F3
 * column (docs/test-explorer-spec.md §4.2). Issue #41 proposed
 * `apps/web/tests/e2e/`; the explorer, which landed later, maps
 * `apps/web/tests/<x>/` to F1/F2 and nothing else, so a suite there would be
 * silently uncounted. Root wins.
 *
 * Two things this configuration decides, both recorded because both were
 * argued:
 *
 * 1. WHAT IT RUNS AGAINST. By default the `pnpm dev` pair: Vite on :5173,
 *    wrangler on :8787, with Vite proxying /v1, /health and /ingress to the
 *    Worker (apps/web/vite.config.ts), so the browser only ever sees one
 *    origin — the same shape as production. Not identical to production: no
 *    service worker (vite-plugin-pwa stays off in dev), unbundled modules, and
 *    Vite's own SPA fallback rather than the Worker's `run_worker_first`
 *    routing. Those three are all-or-nothing failures rather than per-feature
 *    ones, and they are covered by running this same suite against the branch
 *    preview before promoting to main: set E2E_BASE_URL and no server is
 *    started. The preview is Access-gated, hence the header pair below.
 * 2. WHICH SCREENS. Every spec runs under both projects, because "the actions
 *    work on that device" is a claim about each device, not about the code.
 *    Both are Chromium — this is a viewport and input matrix, not a browser
 *    matrix. A test that only makes sense on one device (a swipe, a
 *    hover-revealed control) belongs in its own spec guarded by `isMobile`,
 *    not in a third project.
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const drivingLocalStack = !process.env.E2E_BASE_URL;

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

  // §8's flakiness policy is "never retry-to-green", and a retry count is
  // exactly that mechanised. A failure here means something is broken or the
  // test is; both need diagnosing, not re-running.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL,
    // Kept on failure only: enough to diagnose "it looked wrong" without the
    // cost — or the cross-machine baseline problem — of pixel snapshots, which
    // this tier deliberately does not do.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Cloudflare Access fronts every deployed environment (docs/deployment.md
    // §6), so a preview run needs a service token or it gets the login page
    // instead of the app. Absent locally, where there is no Access in front.
    ...(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
      ? {
          extraHTTPHeaders: {
            'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
          },
        }
      : {}),
  },

  projects: [
    { name: 'desktop', use: { ...desktop } },
    { name: 'phone', use: { ...phone } },
  ],

  // `pnpm dev` already applies migrations, seeds, builds the SPA if it has
  // never been built, and runs both halves — the one command CLAUDE.md
  // promises. Reusing it here is what keeps "no manual setup steps" true, and
  // means the suite can never drift from the way the app actually starts.
  ...(drivingLocalStack
    ? {
        webServer: {
          command: 'pnpm dev',
          url: baseURL,
          // Attaches to a dev server you already have open rather than
          // fighting it for :5173 — but never in CI, where a stray listener
          // would mean testing something other than this commit.
          reuseExistingServer: !process.env.CI,
          // Generous because a cold start migrates, seeds and may build the
          // SPA before Vite listens.
          timeout: 180_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }
    : {}),
});
