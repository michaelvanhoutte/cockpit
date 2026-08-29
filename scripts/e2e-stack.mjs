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

import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paint, run, start, supervise } from './lib/processes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = join(root, 'apps/api');

/** Kept in one place because playwright.config.ts has to agree with them. */
export const WEB_PORT = 5273;
export const API_PORT = 8887;

// Relative, because wrangler resolves --persist-to against its own cwd (apps/api).
const TEMPLATE_DIR = '.wrangler/state-e2e-template';
const RUN_DIR = '.wrangler/state-e2e';
const STAMP = 'cockpit-e2e-template.sha256';

/**
 * What the template was built from. Any change to a migration or to the seed
 * produces a different digest and therefore a rebuild — the failure this
 * avoids is a template that predates a migration, where every test fails
 * against a schema that has not existed for weeks.
 */
function schemaDigest() {
  const hash = createHash('sha256');
  const migrations = join(apiDir, 'migrations');
  for (const name of readdirSync(migrations).sort()) {
    if (!name.endsWith('.sql')) continue;
    hash.update(name);
    hash.update(readFileSync(join(migrations, name)));
  }
  hash.update(readFileSync(join(apiDir, 'seed.sql')));
  return hash.digest('hex');
}

async function ensureTemplate(digest) {
  const stamp = join(apiDir, TEMPLATE_DIR, STAMP);
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === digest) return;

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
  writeFileSync(stamp, `${digest}\n`);
}

/** Stamp the template out as this run's database. The 5ms half of the trade. */
function freshDatabase() {
  rmSync(join(apiDir, RUN_DIR), { recursive: true, force: true });
  cpSync(join(apiDir, TEMPLATE_DIR), join(apiDir, RUN_DIR), { recursive: true });
  rmSync(join(apiDir, RUN_DIR, STAMP), { force: true });
}

try {
  await ensureTemplate(schemaDigest());
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

/**
 * Fails the run if something is already listening, before anything is started.
 * Vite gets this from `--strictPort`; Wrangler needs it spelled out, and needs
 * it for a sharper reason than "the port is taken". A leftover Worker from an
 * aborted run answers /health perfectly well — it is a Worker — so the wait
 * below would accept it and the suite would then run against whatever database
 * that process was started with, silently, which is the one guarantee this
 * whole tier is built on. Binding is the test rather than connecting, because
 * only a bind distinguishes "free" from "listening but not answering yet".
 */
function assertPortFree(port, what) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} is already in use, so the ${what} cannot start there. ` +
                `Something — most likely a stack left behind by an interrupted run — is holding it. ` +
                `Stop that first: this suite will not run against a server it did not start, because ` +
                `its database would not be the fresh one.`,
            )
          : error,
      ),
    );
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Waits until the Worker actually answers, and this is load-bearing rather
 * than tidy. Playwright's `webServer` polls exactly one URL — Vite's — and
 * treats the whole stack as ready the moment that answers. Vite answers in
 * about 1.2 seconds; Wrangler needs about 3, because it has workerd, miniflare
 * and D1 to bring up. Measured here, that leaves a 1.75-second window in which
 * the app is served and every `/v1` call it makes is refused, and the very
 * first thing the first spec does is `page.goto('/')`, whose route resolves
 * workspaces before it renders anything. React Query's couple of retries cover
 * part of the gap, and the rest of the cover is luck — Chromium's own launch
 * time. So Vite is started only once the Worker is up, which makes "Vite is
 * responding" mean "the stack is up" and keeps Playwright's single-URL probe
 * honest.
 */
async function waitForApi(child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the test API exited before it was ready (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      // The status is not the answer: /health is 200 whether or not D1 responds,
      // and reports the database in its body (apps/api/src/http/app.ts). Since
      // bringing D1 up is the slow part this wait exists for, `res.ok` alone
      // would let the suite start against a Worker whose database is not there.
      if (res.ok && (await res.json())?.db === true) return;
    } catch {
      // Not listening yet, or answering with something that is not JSON.
      // Connection refused is the expected state for most of this loop.
    }
    await delay(200);
  }
  throw new Error(`the test API never answered on :${API_PORT}`);
}

try {
  await assertPortFree(API_PORT, 'test API');
  await assertPortFree(WEB_PORT, 'test web server');
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
  await waitForApi(api);
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  api.kill('SIGTERM');
  process.exit(1);
}

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
