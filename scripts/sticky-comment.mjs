//
// Post or update one comment on a pull request, identified by a marker.
//
// The decisions are in scripts/lib/sticky-comment.mjs, which node --test covers
// in the Scripts CI job; this is the subprocess and the argument handling.
//
// Usage: node scripts/sticky-comment.mjs <marker> <body>
// Env:   GITHUB_REPOSITORY, PR_NUMBER, GH_TOKEN
//

import { execFileSync } from 'node:child_process';

import { upsertSticky } from './lib/sticky-comment.mjs';

const [marker, body] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;

if (!marker || !body || !repo || !pr) {
  console.log('::warning::sticky-comment needs a marker, a body, GITHUB_REPOSITORY and PR_NUMBER.');
  process.exit(0);
}

const gh = (args, input) =>
  execFileSync('gh', args, { input, encoding: 'utf8', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

try {
  const { action, id } = upsertSticky({ gh, repo, pr, marker, body });
  console.log(`Comment ${action}${id === null ? '' : ` (${id})`}.`);
} catch (error) {
  // Never fatal. A comment is a convenience; failing a deploy or a review over
  // one would be worse than not having it.
  console.log(`::warning::Could not leave the comment: ${error.message}`);
}
