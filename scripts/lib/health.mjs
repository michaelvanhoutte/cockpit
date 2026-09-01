//
// What a deployed environment's `/health` answer means, and how long to keep
// asking before calling the deploy bad.
//
// This replaced a `run:`-adjacent bash script for the reason recorded in
// review-gate.mjs: a decision that nothing can run is a decision nothing
// checks. It also replaced a check that asked exactly once. That single ask was
// wrong from the moment `/health` grew a second half: it now opens an account
// store, and the *first* request after a deploy is the one that creates that
// store and applies every outstanding change to it. The post-deploy step runs
// about ten seconds after the deploy, so it was racing the one request that
// does real work, and `curl --retry` never helped - it retries a connection
// that failed, never a 200 whose body says no.
//
// Observed on the deploy of a762ff1: `{"ok":false,"register":true,"store":false}`
// ten seconds after the deploy, healthy on every ask afterwards.
//
// **The retry is bounded and loud, not a way of getting to green.** Only the
// two states that can plausibly right themselves are retried; a redirect or a
// login page is a configuration fault that waiting cannot fix, and those still
// fail on the first answer. Every attempt is reported, so an environment that
// needed four goes says so in the deploy log instead of looking identical to
// one that was healthy immediately - which is the evidence for whether that
// first-touch failure is a race or something that needs fixing in the app.
//
// Everything that decides anything takes its inputs as arguments and reads
// nothing - no network, no clock - for the same reason the rest of scripts/lib
// does.
//

/** How long to keep asking, and how often, before a deployment counts as bad. */
export const WINDOW_MS = 60_000;
export const INTERVAL_MS = 3_000;

/**
 * What one answer from `/health` means.
 *
 * `status` is 0 when nothing came back at all. `body` is the raw text, because
 * whether it is even our JSON is one of the things being decided.
 */
export function readAnswer({ status, body }) {
  if (status === 0) {
    return { state: 'unreachable', message: 'was unreachable (DNS, TLS, or timeout).' };
  }
  if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
    return {
      state: 'gated',
      message:
        `redirected (${status}). /health must be reachable without Cloudflare Access: add a Bypass ` +
        'policy scoped to the /health path (docs/deployment.md, "`/health` must stay outside the ' +
        'gate"). The uptime monitor in architecture\'s Observability section depends on this too.',
    };
  }
  if (status !== 200) {
    return { state: 'error', message: `returned ${status}.` };
  }

  let answer;
  try {
    answer = JSON.parse(body);
  } catch {
    answer = null;
  }
  if (!answer || typeof answer.ok !== 'boolean') {
    return {
      state: 'not-ours',
      message:
        'returned 200 but not our JSON, so something answered in front of the Worker - usually an ' +
        'Access login page, so the Bypass policy has come undone.',
    };
  }
  if (answer.ok) return { state: 'healthy', message: 'healthy.' };

  return {
    state: 'unhealthy',
    message:
      'answered, and said it is not well. `register` and `store` say which half: a false `store` is ' +
      'most often an update that will not apply. The reason is in the Worker\'s logs, never in this ' +
      'body.',
  };
}

/**
 * Whether waiting could change this answer.
 *
 * Only the two that a deployment settling can fix. A redirect and a login page
 * are both somebody having changed the perimeter, and asking twenty more times
 * only delays saying so.
 */
export function worthRetrying(state) {
  return state === 'unhealthy' || state === 'unreachable';
}

/**
 * Asks until the deployment says it is healthy, or until the window closes.
 *
 * @returns {Promise<{ok: boolean, attempts: number, answer: object, body: string}>}
 */
export async function checkUntilHealthy(ask, options = {}) {
  const {
    now = Date.now,
    delayMs = INTERVAL_MS,
    windowMs = WINDOW_MS,
    onAttempt = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const deadline = now() + windowMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const { status, body } = await ask();
    const answer = readAnswer({ status, body });
    onAttempt({ attempt: attempts, status, answer, body });

    if (answer.state === 'healthy') return { ok: true, attempts, answer, body };
    if (!worthRetrying(answer.state)) return { ok: false, attempts, answer, body };
    // Checked after the ask, so the window is a limit on waiting rather than on
    // trying: a run that starts with no time left still gets one real answer.
    if (now() >= deadline) return { ok: false, attempts, answer, body };
    await sleep(delayMs);
  }
}
