#!/usr/bin/env node
//
// The stack the browser tests (F3) drive. Started by playwright.config.ts; not
// something to run by hand, though nothing stops you.
//
// It is a *second*, throwaway copy of the application, deliberately not the one
// `pnpm dev` runs:
//
//   - Its own ports, against the ones `pnpm dev` uses, so a test run and the
//     app you are clicking through can be open at the same time and neither
//     notices the other. Which ports depends on the checkout
//     (scripts/lib/ports.mjs): the primary one gets :5273 and :8887, a linked
//     worktree a pair of its own, so two worktrees can run this suite at the
//     same time as well.
//   - Its own state directory, restored to a known state before every run. The
//     tests therefore start from the same place, every time, and may assert
//     what is on screen rather than only that their own row appeared.
//
// The template holds the register only. An account's own store is a Durable
// Object nothing outside the Worker can write to, so it is not in the template
// and is instead created, brought up to date and given its starting workspaces
// by the run's first request - from the same empty start every time, which is
// the property that matters here.
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

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paint, run, start, stop, supervise } from './lib/processes.mjs';
import { howToFreeThePort, isLinkedWorktree, portsFor } from './lib/ports.mjs';
import {
  assertPortFree,
  exitReport,
  fatalReason,
  newestLog,
  schemaDigest,
  templateIsCurrent,
  waitForApi,
} from './lib/stack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = join(root, 'apps/api');

/**
 * Derived rather than written down, and exported because playwright.config.ts
 * has to reach the same answer - which it now does by asking the same function
 * rather than by holding a copy of the number that somebody has to remember to
 * keep in step.
 */
const ports = portsFor(root, { linked: isLinkedWorktree(root), env: process.env });
export const WEB_PORT = ports.e2eWeb;
export const API_PORT = ports.e2eApi;

// Relative, because wrangler resolves --persist-to against its own cwd (apps/api).
const TEMPLATE_DIR = '.wrangler/state-e2e-template';
const RUN_DIR = '.wrangler/state-e2e';
const STAMP = 'cockpit-e2e-template.sha256';

/**
 * Where Wrangler writes the log that says why it fell over.
 *
 * It writes one either way; the point of naming it is that the default is
 * `~/.config/.wrangler/logs`, which is outside the repository — so on a CI
 * runner it goes with the machine and the one record of what happened is
 * thrown away with it. Named here, `.github/workflows/ci.yml` can keep it
 * beside the Playwright artefacts on a failed run.
 *
 * That is not a hypothetical. `wrangler dev` exited 1 twenty-three seconds into
 * the run on `main` at bc840bb, printing an empty `✘ [ERROR]` and taking the
 * rest of the stack down with it (`supervise` in lib/processes.mjs), so
 * twenty-six tests failed with a connection refused and every screenshot the
 * job did keep was of the same blank page. The reason existed, in this file,
 * on a runner that was then deleted.
 *
 * Absolute, unlike `--persist-to` above. Both are resolved against Wrangler's
 * own cwd, which is apps/api; `--persist-to` is written relative because that
 * is exactly where its directory belongs, while this one has to agree with a
 * path written in a workflow file at the root, and a relative value would make
 * the two look unrelated.
 *
 * A directory, not a file: Wrangler treats the value as a directory unless it
 * ends in `.log`, and names each run's file inside it. It prunes its own old
 * files, so this does not grow without end.
 */
const LOG_DIR = join(apiDir, '.wrangler/logs-e2e');

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

/**
 * Why this suite in particular will not simply use the port.
 *
 * `pnpm dev` may perfectly well run against a server somebody else started; it
 * only cannot bind twice. This suite may not, and that is the sentence worth
 * keeping: its whole premise is a database rebuilt on the way up, and a server
 * it did not start is holding one it did not build. The rest - which is what to
 * actually do about it - is the same answer everywhere, so it comes from the
 * same place.
 */
function refusing(which, port) {
  return (
    `This suite will not run against a server it did not start, because its database ` +
    `would not be the fresh one. ${howToFreeThePort(which, port)}`
  );
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
  await assertPortFree(API_PORT, 'test API', () => refusing('e2eApi', API_PORT));
  await assertPortFree(WEB_PORT, 'test web server', () => refusing('e2eWeb', WEB_PORT));

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

// Noted before the Worker is started, so a log from an *earlier* run is never
// read out as this one's reason. Wrangler keeps its old files until it prunes
// them, and the case that matters is a Worker that died before writing
// anything of its own.
const startedAt = Date.now();

const api = start(
  ['--filter', '@cockpit/api', 'exec', 'wrangler', 'dev', '--port', String(API_PORT), '--persist-to', RUN_DIR],
  'test api',
  '36',
  root,
  { WRANGLER_LOG_PATH: LOG_DIR },
);

try {
  await waitForApi(api, API_PORT);
} catch (error) {
  // The same reason, for the half of the story that happens before the stack is
  // up: a Worker that never started has a log too, and printing only "it exited
  // before it was ready (1)" sends the reader to an artifact for a sentence.
  //
  // Inside its own try, and that is not belt and braces: stop(api) below is
  // what keeps a half-started Wrangler from holding the API port, which the
  // guard at the top of this file then refuses to start against on every later
  // run. Reading a file that Wrangler may be pruning must not come between the
  // two.
  console.error(paint('31', `\n${error.message}`));
  try {
    const startupLog = newestLog(LOG_DIR, startedAt);
    if (startupLog) {
      const reason = fatalReason(readFileSync(startupLog, 'utf8'));
      console.error(paint('31', reason ? `  ${reason}` : `  Wrangler's log: ${startupLog}`));
    }
  } catch (couldNotRead) {
    console.error(paint('31', `  (could not read Wrangler's log: ${couldNotRead.message})`));
  }
  // stop(), not api.kill(): on Windows the child here is a shell, and signalling
  // it would leave Wrangler holding the API port — which the check above would
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

/**
 * Why a half of the stack has gone, for supervise() to print beside the fact
 * that it has.
 *
 * Only the Worker has an answer to give: Wrangler keeps a log (LOG_DIR above),
 * and reading it here is the difference between "a server exited (1)" and the
 * sentence that names what happened. Vite falls through to the same report
 * without one, which is honest — it writes no log, so there is nothing to read.
 */
function whyItWent(child, code) {
  if (child !== api) return exitReport('test web server', code, null, null);
  const logPath = newestLog(LOG_DIR, startedAt);
  return exitReport('test API', code, logPath, logPath === null ? null : readFileSync(logPath, 'utf8'));
}

supervise([api, web], stop, whyItWent);
