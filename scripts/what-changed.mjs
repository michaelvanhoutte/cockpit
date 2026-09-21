//
// The I/O around scripts/lib/what-changed.mjs, for the classifier step of
// ci.yml's `checks` job - the only consumer left since "Remove the remote
// code and security reviews" deleted the two that also read it. Everything
// that decides anything - including every way the decision can fail - is in
// the module, which node --test covers in the Scripts step. This supplies
// the two readers, prints what it is told to, and writes both outputs;
// `security_changed` is written for a reader that no workflow currently is,
// since scripts/local-changes.mjs answers the same question of a working
// tree for Review findings' table.
//
// Usage: node scripts/what-changed.mjs   (on a runner, with GITHUB_OUTPUT set)
//
// Every classifier step but one runs the copy of this that the *base* commit
// carries, not this branch's - see ci.yml for why - so an edit here reaches
// CI only once it has merged. The one exception is ci.yml's own `checks` job
// on a push to `main`, which runs this branch's copy directly: `main` is
// already the trusted branch at that point, so there is no other branch's
// diff for it to talk itself out of being reviewed on.
//

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { classify } from './lib/what-changed.mjs';

const { changed, security, lines } = classify({
  eventName: process.env.GITHUB_EVENT_NAME,
  eventPath: process.env.GITHUB_EVENT_PATH,
  readFile: (path) => readFileSync(path, 'utf8'),
  // `--no-renames`, so a file moved out of `docs/` lists its old path as well as
  // its new one. With rename detection on, `--name-only` prints the destination
  // alone, and `apps/api/src/x.ts` moved to `docs/x.md` would read as a
  // documentation change while a source file left the tree.
  //
  // `-z`, so a path with a space or a non-ASCII character arrives as itself
  // rather than in git's quoted form.
  gitDiff: (range) => execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', range], { encoding: 'utf8' }),
});

for (const line of lines) console.log(line);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `product_changed=${changed}\nsecurity_changed=${security}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  // Says nothing about `security` here: this summary belongs to ci.yml's
  // `checks` job, which runs no security-specific work, so a line about it
  // would claim something about a job that never runs there.
  const summary = changed
    ? 'This diff touches the product, so every mechanical check runs.'
    : 'This diff touches only `docs/`, `.claude/` and root-level Markdown, so the mechanical checks skip. Each still reports, as skipped.';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## What changed\n\n${summary}\n`);
}
