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

/**
 * The `--var` pairs for the local Worker: the branch, and where its records go.
 * `USAGE_RECORDING_URL` in the shell's environment points them elsewhere, which
 * is how a local Worker is made to send to another one; it is not read from
 * `.dev.vars`, which carries the token alone.
 */
export function recordingVars({ branch, origin, environment }) {
  return [
    ...(branch ? [`CHECKOUT_BRANCH:${branch}`] : []),
    `USAGE_RECORDING_URL:${environment.USAGE_RECORDING_URL || origin}`,
  ];
}
