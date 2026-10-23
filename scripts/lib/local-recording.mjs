//
// What `pnpm dev` hands the local Worker so that its Claude calls are recorded
// ("Record staging's and local Claude calls in production, under a token per
// environment", issue 1458): the branch the checkout is on, and where the
// records are sent. Decided here so it is asserted without starting anything.
//

import { execFileSync } from 'node:child_process';

/**
 * The branch a checkout is on, or the short commit it is detached at, or `null`
 * where git cannot say (the records then carry no branch).
 */
export function checkoutBranch(root, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })) {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch && branch !== 'HEAD') return branch;
    return git(['rev-parse', '--short', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Production's own address, read from the top-level `APP_ORIGIN` in
 * `wrangler.jsonc` - the first one written there, staging's being inside its
 * own environment further down - so there is one place it is written.
 */
export function productionOrigin(wranglerSource) {
  const found = /"APP_ORIGIN"\s*:\s*"(https:\/\/[^"]+)"/.exec(wranglerSource);
  if (!found) throw new Error("wrangler.jsonc names no APP_ORIGIN for production to send usage records to");
  return found[1];
}

// These values reach a `shell: true` command line (scripts/lib/processes.mjs
// joins the arguments into one string for cmd.exe on Windows), and a git ref
// name may hold `& | ( ) < > % ;`. So only plain characters are let through.
const PLAIN_BRANCH = /^[A-Za-z0-9._/-]+$/;
const PLAIN_URL = /^https?:\/\/[A-Za-z0-9._:/-]+$/;

/**
 * The `--var` pairs for the local Worker: the branch, and where its records go.
 * `USAGE_RECORDING_URL` in the shell's environment points them elsewhere, which
 * is how a local Worker is made to send to another one; it is not read from
 * `.dev.vars`, which carries the token alone.
 *
 * **A branch or a shell-given address with anything but plain characters is
 * dropped** (the records then carry no branch, or go to production), because
 * both land on a shell command line. Production's own address is the repo's, and
 * is refused outright if it is not plain.
 */
export function recordingVars({ branch, origin, environment }) {
  if (!PLAIN_URL.test(origin)) throw new Error('the production address in wrangler.jsonc is not a plain URL to record usage to');
  const given = environment.USAGE_RECORDING_URL;
  return [
    ...(branch && PLAIN_BRANCH.test(branch) ? [`CHECKOUT_BRANCH:${branch}`] : []),
    `USAGE_RECORDING_URL:${given && PLAIN_URL.test(given) ? given : origin}`,
  ];
}
