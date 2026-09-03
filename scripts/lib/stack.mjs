//
// The decisions scripts/e2e-stack.mjs makes before it starts anything: is the
// database template still current, is the port ours to take, is the Worker
// actually up. They live here rather than in the script because the script is
// procedural top to bottom — importing it starts a stack — and these are the
// parts worth testing without one.
//

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
export function assertPortFree(port, what, advice) {
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

/**
 * Wrangler prints this once, on its way out, when the command it was given has
 * failed. It is the only thing in the log that separates the run's last fatal
 * from the ordinary stream errors above it, which carry the same `[ERROR]`
 * marker and are far more numerous — a passing run holds about twenty-five of
 * them ("Close the live-updates stream quietly when a browser walks away",
 * issue 128).
 */
const ENDED_BADLY = 'If you think this is a bug then please create an issue';

/**
 * The newest log Wrangler wrote in `dir` since `since`, or null if it wrote
 * none.
 *
 * Newest rather than named, because the name carries the start time and this
 * suite starts exactly one `wrangler dev`; the template build runs earlier and
 * writes elsewhere.
 *
 * `since` is what stops the previous run's log being read out as this run's
 * reason. Wrangler keeps its old files until it prunes them, so a Worker that
 * died before it could write anything — a failed spawn, which is what an
 * application-control policy blocking `workerd.exe` looks like — would
 * otherwise be explained by whatever went wrong the last time.
 *
 * A file that disappears between the listing and the stat is skipped rather
 * than thrown over: Wrangler prunes its own old files, and this runs from an
 * exit handler where a throw costs more than a missing candidate.
 */
export function newestLog(dir, since = 0) {
  if (!existsSync(dir)) return null;
  let newest = null;
  let newestAt = -Infinity;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.log')) continue;
    const path = join(dir, name);
    let at;
    try {
      at = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (at < since || at <= newestAt) continue;
    newest = path;
    newestAt = at;
  }
  return newest;
}

/**
 * Why a `wrangler dev` run ended, read out of its own log — because what it
 * prints to the terminal is often nothing at all.
 *
 * That is not a figure of speech. The crash this exists for prints `✘ [ERROR]`
 * with an empty message, because the ProxyWorker's error crosses a worker
 * boundary as a plain object and Wrangler rebuilds it as a bare `Error`
 * (`castErrorCause`, wrangler 4.128.0); the reason survives only in the log,
 * as a `cause`. Two E2E jobs died that way on 3 September 2026 and the console
 * said nothing either time, so the reason cost an artifact download each.
 *
 * Read backwards from `ENDED_BADLY` so the ordinary stream errors above it are
 * never mistaken for the reason: the fatal is the *last* thing that happened,
 * and everything before that marker belongs to the run rather than to its end.
 * A named source is preferred over a printed line for the same reason - it only
 * appears when a controller reported a failure, while `[ERROR]` is also what
 * every closed tab produces.
 *
 * Pure, and takes the text rather than the path, so the shapes below can be
 * asserted without a Worker to kill.
 */
export function fatalReason(log) {
  const endedBadly = log.lastIndexOf(ENDED_BADLY);
  if (endedBadly === -1) return null;
  const beforeTheEnd = log.slice(0, endedBadly);

  // `Error in <source>: <reason>` followed by the cause it was given, which is
  // where the sentence a human wants ("Network connection lost.") actually is.
  const named = [...beforeTheEnd.matchAll(/^Error in [^\n:]+: (.+)$/gm)].at(-1);
  if (named) {
    const reason = named[1].trim();
    // Only within that record. The one after it is `=> Error contextual data`,
    // a megabyte of bundled configuration and source that has `message:` in it
    // more than once — so an unbounded search would answer a fatal with no
    // cause of its own by quoting a line of somebody else's library.
    const record = beforeTheEnd.slice(named.index).split('\n---\n')[0];
    const cause = record.match(/message: '([^']*)'/);
    return cause?.[1] ? `${reason}: ${cause[1]}` : reason;
  }

  // Otherwise whatever Wrangler managed to print. `[ERROR]` rather than the
  // cross that precedes it: that is `✘` on a terminal that can draw one and a
  // plain `X` on Windows, and both end up in the file.
  //
  // The *last* one, and no skipping past it when it is empty. Skipping was the
  // bug: the fatal this whole function exists for prints an empty `[ERROR]`,
  // so passing over it reached back into the ordinary stream errors above and
  // named a closed tab as the cause of death — the one thing the paragraph
  // above promises not to do. An empty last error means Wrangler recorded no
  // reason, which exitReport says out loud along with where to look.
  const printed = [...beforeTheEnd.matchAll(/\[ERROR\][ \t]*(.*)$/gm)].at(-1);
  return printed?.[1].trim() || null;
}

/**
 * The sentence to print when a half of the stack has exited: what died, with
 * what code, and — where there is a log to read — why.
 *
 * Assembled here rather than at the call site so the "no log" and "a log that
 * explains nothing" cases are decided once and can be asserted. Both are
 * ordinary: Vite writes no log at all, and a Worker that was killed rather than
 * failing leaves one with no fatal in it.
 */
export function exitReport(what, code, logPath, log) {
  const reason = log === null ? null : fatalReason(log);
  if (reason) return `the ${what} exited (${code}): ${reason}\n  Wrangler's log: ${logPath}`;
  if (logPath) return `the ${what} exited (${code}); Wrangler's log records no reason: ${logPath}`;
  return `the ${what} exited (${code}), leaving no log to say why`;
}
