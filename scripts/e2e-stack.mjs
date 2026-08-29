#!/usr/bin/env node
//
// The stack the browser tests (F3) drive. Started by playwright.config.ts; not
// something to run by hand, though nothing stops you.
//
// It is a *second*, throwaway copy of the application, deliberately not the one
// `pnpm dev` runs:
//
//   - Its own ports (5273/8887, against dev's 5173/8787), so a test run and the
//     app you are clicking through can be open at the same time and neither
//     notices the other.
//   - Its own D1 directory, restored to a known state before every run. The
//     tests therefore start from exactly the seed, every time, and may assert
//     what is on screen rather than only that their own row appeared.
//
// Why a restored copy rather than migrating and seeding each run: measured,
// `wrangler d1 migrations apply` plus `d1 execute` costs about 7 seconds, almost
// all of it two Node processes starting, while copying the 220KB state
// directory costs 5 milliseconds. So the migrated-and-seeded database is built
// once as a template and stamped out per run. The template is rebuilt whenever
// the migrations or the seed change, keyed by their contents, so there is no
// stale-template failure mode to remember.
//
// The alternative this replaced was pointing the tests at the same database
// `pnpm dev` uses. It worked, and it meant test rows accumulating in the
// database being used to develop, tests that could never assert exact state,
// and a suite whose behaviour depended on what had been clicked earlier. The
// backend's own integration tests get a fresh database per file from the
// Workers pool; this is the browser tier being consistent with that.
//
// This file is orchestration only. The decisions it makes on the way up — is
// the template current, is the port free, is the Worker really answering — are
// in lib/stack.mjs, where they can be tested without starting anything.
//

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paint, run, start, stop, supervise } from './lib/processes.mjs';
import { assertPortFree, schemaDigest, templateIsCurrent, waitForApi } from './lib/stack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = join(root, 'apps/api');

/** Kept in one place because playwright.config.ts has to agree with them. */
export const WEB_PORT = 5273;
export const API_PORT = 8887;

// Relative, because wrangler resolves --persist-to against its own cwd (apps/api).
const TEMPLATE_DIR = '.wrangler/state-e2e-template';
const RUN_DIR = '.wrangler/state-e2e';
const STAMP = 'cockpit-e2e-template.sha256';

async function ensureTemplate(digest) {
  const stamp = join(apiDir, TEMPLATE_DIR, STAMP);
  if (templateIsCurrent(stamp, digest)) return;

  rmSync(join(apiDir, TEMPLATE_DIR), { recursive: true, force: true });
  await run(
    ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'cockpit', '--local', '--persist-to', TEMPLATE_DIR],
    'building the test database template: migrations',
    apiDir,
  );
  await run(
    ['exec', 'wrangler', 'd1', 'execute', 'cockpit', '--local', '--persist-to', TEMPLATE_DIR, '--file=./seed.sql'],
    'building the test database template: seed',
    apiDir,
  );
  mkdirSync(join(apiDir, TEMPLATE_DIR), { recursive: true });
  // Written last, so a build interrupted between the migrations and the seed
  // leaves no stamp and is rebuilt next time rather than trusted.
  writeFileSync(stamp, `${digest}\n`);
}

/** Stamp the template out as this run's database. The 5ms half of the trade. */
function freshDatabase() {
  rmSync(join(apiDir, RUN_DIR), { recursive: true, force: true });
  cpSync(join(apiDir, TEMPLATE_DIR), join(apiDir, RUN_DIR), { recursive: true });
  rmSync(join(apiDir, RUN_DIR, STAMP), { force: true });
}

try {
  // FIRST, before anything destructive or slow. The stack this guard exists to
  // catch — a Worker left behind by an interrupted run — is persisted to the
  // very directory freshDatabase() deletes, so checking afterwards would pull
  // the storage out from under the process we are about to refuse to run
  // against, and would spend a possibly minutes-long build before noticing the
  // conflict at all.
  await assertPortFree(API_PORT, 'test API');
  await assertPortFree(WEB_PORT, 'test web server');

  await ensureTemplate(schemaDigest(apiDir));
  freshDatabase();

  // Wrangler refuses to start when the assets directory does not exist. Only
  // existence matters here, same as in scripts/dev.mjs: the SPA is served by
  // Vite, so a stale dist is fine.
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    console.log(paint('2', '  apps/web/dist is missing; Wrangler needs it to start'));
    await run(['build'], 'building', root);
  }
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  process.exit(1);
}

const api = start(
  ['--filter', '@cockpit/api', 'exec', 'wrangler', 'dev', '--port', String(API_PORT), '--persist-to', RUN_DIR],
  'test api',
  '36',
  root,
);

try {
  await waitForApi(api, API_PORT);
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  // stop(), not api.kill(): on Windows the child here is a shell, and signalling
  // it would leave Wrangler holding :8887 — which the port check above would
  // then refuse to start against on every later run.
  stop(api);
  process.exit(1);
}

// Vite starts only now, so that Playwright's single-URL probe on the web port
// means the whole stack is up rather than half of it.
//
// --strictPort so a busy port fails the run instead of quietly moving to
// another one, which would leave Playwright waiting on a URL nothing serves.
// COCKPIT_API_ORIGIN is what points this Vite at this Wrangler rather than at
// the one `pnpm dev` may also be running (apps/web/vite.config.ts).
const web = start(
  ['--filter', '@cockpit/web', 'exec', 'vite', '--port', String(WEB_PORT), '--strictPort'],
  'test web',
  '35',
  root,
  { COCKPIT_API_ORIGIN: `http://127.0.0.1:${API_PORT}` },
);

console.log(
  `\n${paint('36', 'test api')} http://localhost:${API_PORT}   ${paint('35', 'test web')} http://localhost:${WEB_PORT}   (a fresh database, thrown away next run)\n`,
);

supervise([api, web]);
