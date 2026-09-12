//
// The I/O around scripts/lib/what-changed.mjs, for the classifier step of
// ci.yml's `checks` job. Everything that decides anything - including every
// way the decision can fail - is in the module, which node --test covers in
// the Scripts step. This supplies the two readers, prints what it is told
// to, and writes one output.
//
// Usage: node scripts/what-changed.mjs   (on a runner, with GITHUB_OUTPUT set)
//
// The classifier step runs the copy of this that the *base* commit carries,
// not this branch's - see ci.yml for why - so an edit here reaches CI only
// once it has merged.
//

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { classify } from './lib/what-changed.mjs';

const { changed, lines } = classify({
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
  appendFileSync(process.env.GITHUB_OUTPUT, `product_changed=${changed}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = changed
    ? 'This diff touches the product, so every mechanical check runs.'
    : 'This diff touches only `docs/`, `.claude/` and root-level Markdown, so the mechanical checks skip. Each still reports, as skipped.';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## What changed\n\n${summary}\n`);
}
