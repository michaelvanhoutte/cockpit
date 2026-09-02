//
// The decisions scripts/e2e-stack.mjs makes before it starts anything: is the
// database template still current, is the port ours to take, is the Worker
// actually up. They live here rather than in the script because the script is
// procedural top to bottom — importing it starts a stack — and these are the
// parts worth testing without one.
//

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * What the test database template was built from: every migration, by name and
 * content, plus the seed. Any change produces a different digest and therefore
 * a rebuild — the failure this avoids is a template that predates a migration,
 * where every test fails against a schema that has not existed for weeks.
 */
export function schemaDigest(apiDir) {
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

/**
 * Whether the template on disk was built from this schema. A missing stamp
 * counts as stale, so a half-built template — interrupted between the
 * migrations and the seed — is rebuilt rather than trusted.
 */
export function templateIsCurrent(stampPath, digest) {
  if (!existsSync(stampPath)) return false;
  return readFileSync(stampPath, 'utf8').trim() === digest;
}

/**
 * Fails if something is already listening, before anything is started. Vite
 * gets this from `--strictPort`; the Worker needs it spelled out, and needs it
 * for a sharper reason than "the port is taken". A leftover Worker from an
 * aborted run answers /health perfectly well — it is a Worker — so the wait
 * below would accept it, and the suite would then run against whatever database
 * that process was started with. Binding is the test rather than connecting,
 * because only a bind distinguishes "free" from "listening but not answering
 * yet".
 */
export function assertPortFree(port, what, advice = whatTheSuiteSays) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use, so the ${what} cannot start there. ${advice()}`)
          : error,
      ),
    );
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * What to do about it, for the browser suite - which is the caller this check
 * was written for, so it is the default rather than something every call has to
 * pass. `pnpm dev` passes its own, because the answer there is different: it
 * *may* run against a server it did not start, it simply cannot bind twice, and
 * the second thing it can be is another worktree sharing this one's slot
 * (scripts/lib/ports.mjs).
 */
function whatTheSuiteSays() {
  return (
    `Something — most likely a stack left behind by an interrupted run — is holding it. ` +
    `Stop that first: this suite will not run against a server it did not start, because ` +
    `its database would not be the fresh one.`
  );
}

/**
 * Waits until the Worker actually answers, and this is load-bearing rather than
 * tidy. Playwright's `webServer` polls exactly one URL — Vite's — and treats the
 * whole stack as ready the moment that answers. Vite answers in about 1.2
 * seconds; Wrangler needs about 3, because it has workerd, miniflare and D1 to
 * bring up. Measured, that left a 1.75-second window in which the app was served
 * and every `/v1` call it made was refused, and the first thing the first spec
 * does is open "/", whose route resolves workspaces before rendering anything.
 *
 * The status alone is not the answer: /health is 200 whether or not the data is
 * reachable, and reports that in its body (apps/api/src/http/app.ts). Since
 * bringing the data layer up is the slow part this wait exists for, `res.ok` on
 * its own would let the suite start against a Worker whose data is not there.
 *
 * The body's `ok` is what is read, rather than one of the two halves beside it:
 * a spec needs the register *and* an account store, and `ok` is the field that
 * means both. It also stays right when a third thing is added to that answer.
 *
 * The seams exist for the tests: nothing here should need a real Worker, a real
 * clock, or sixty seconds to prove which branch it takes.
 */
export async function waitForApi(child, port, options = {}) {
  const { fetchImpl = fetch, delayMs = 200, timeoutMs = 60_000, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the test API exited before it was ready (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health`);
      if (res.ok && (await res.json())?.ok === true) return;
    } catch {
      // Not listening yet, or answering with something that is not JSON.
      // Connection refused is the expected state for most of this loop.
    }
    await delay(delayMs);
  }
  throw new Error(`the test API never answered on :${port}`);
}
