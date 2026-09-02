//
// The I/O around scripts/lib/health.mjs, for the deploy workflows' health step.
// Everything that decides anything is in the module, which node --test covers
// in the Scripts CI job; this fetches, prints, and sets an exit code, so there
// is nothing here for a test to hold.
//
// It asserts that a deployed environment is up and its data reachable.
// `/health` returns {"ok":true,"register":true,"store":true}: the register
// answered, and a store belonging to no account was opened and brought up to
// date (architecture, "Observability"). Both halves matter - an account's data
// lives in its own store, so a check on the register alone would pass this
// assertion while every real request to the deployment failed.
//
// /health must answer *without* a sign-in, because two things depend on
// reaching it unauthenticated: this post-deploy check, and the external uptime
// monitor that is the only observability layer not running on the app's own
// code (docs/deployment.md, "`/health` answers without a sign-in"). If anything
// is ever put in front of it, this receives a page instead of JSON - so that is
// detected and named rather than surfacing as a mysterious failed promotion.
//
// Usage: node scripts/health-check.mjs <base-url>
//

import { checkUntilHealthy, failureReport } from './lib/health.mjs';

const base = process.argv[2];
if (!base) {
  console.error('usage: health-check.mjs <base-url>');
  process.exit(2);
}

const endpoint = `${base.replace(/\/+$/, '')}/health`;

/**
 * One ask. A request that never lands is status 0, which the module reads as
 * "unreachable" - a state it is willing to wait on, unlike a redirect.
 *
 * No redirect following: a redirect is a signal here, not something to chase.
 */
async function ask() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, { redirect: 'manual', signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

const result = await checkUntilHealthy(ask, {
  onAttempt: ({ attempt, status, answer }) =>
    console.log(`GET ${endpoint} -> ${status} (attempt ${attempt}): ${answer.state}`),
});

if (result.ok) {
  // Said out loud when it took more than one go. The first request after a
  // deploy is the one that brings an account store up to date, so "healthy on
  // the second ask" is the evidence for whether that is a race worth living
  // with or something to fix in the application.
  const took = result.attempts > 1 ? ` after ${result.attempts} attempts` : '';
  console.log(`healthy${took}: ${result.body}`);
} else {
  console.log(`::error::${endpoint} ${failureReport(result)}`);
  if (result.body) console.log(result.body.split('\n').slice(0, 5).join('\n'));
}

// `exitCode` rather than `process.exit()`, which tears the process down while
// the connection this just made is still open: on Windows that aborts inside
// libuv (`!(handle->flags & UV_HANDLE_CLOSING)`) and the run reports 127
// instead of the verdict. Setting the code and letting Node finish keeps the
// exit status the thing the deploy reads.
process.exitCode = result.ok ? 0 : 1;
