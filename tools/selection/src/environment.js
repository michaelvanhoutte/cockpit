/**
 * What the two command lines (cli.js, the report; alarm-cli.js, the alarm) ask
 * of the machine they run on: the checkout's git, the repository it points at,
 * and a GitHub token. Quiet on failure, since a missing git, remote or `gh` is
 * not an error here, just no answer.
 */

import { execFileSync } from 'node:child_process';

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export const git = (args) => run('git', args);

export function repoFromGitRemote() {
  const url = git(['config', '--get', 'remote.origin.url']);
  const match = url?.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

/** A token is optional against a public repository, but 60 requests an hour is not enough for a full window. `gh` is asked last, which is what makes a local run work without any setup. */
export function resolveToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || run('gh', ['auth', 'token']) || undefined;
}
