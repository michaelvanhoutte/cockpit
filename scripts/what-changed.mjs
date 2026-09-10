//
// The I/O around scripts/lib/what-changed.mjs, for the `changes` job in ci.yml
// and codeql.yml. Everything that decides anything is in the module, which
// node --test covers in the Scripts job; this reads the event payload, asks git
// for the diff, prints and writes one output.
//
// Usage: node scripts/what-changed.mjs   (on a runner, with GITHUB_OUTPUT set)
//
// **Every way this can fail says "product changed".** A skipped job satisfies a
// required status check (docs/deployment.md, "Bootstrap runbook"), which is what
// makes the whole feature work and also what makes a wrong answer here
// dangerous: a crash that read as "documentation only" would wave an untested
// change through eight green ticks. So an unreadable payload, an unknown event
// and a git failure all run the full suite, and the job that reads this output
// treats a missing one the same way.
//

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { diffRange, pathsFromDiff, productChanged, productPaths } from './lib/what-changed.mjs';

/** The event payload, or `{}` where there is none to read. */
function event() {
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Every path the range touched, or null where git could not answer.
 *
 * `--no-renames`, so a file moved out of `docs/` lists its old path as well as
 * its new one. With rename detection on, `--name-only` prints the destination
 * alone, and `apps/api/src/x.ts` moved to `docs/x.md` would read as a
 * documentation change while a source file left the tree.
 *
 * `-z`, so a path with a space or a non-ASCII character arrives as itself
 * rather than in git's quoted form.
 */
function changedPaths(range) {
  try {
    return pathsFromDiff(execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', range], { encoding: 'utf8' }));
  } catch (error) {
    console.log(`::warning::Could not diff ${range}, so every check runs: ${error.message.replace(/\s+/g, ' ').trim()}`);
    return null;
  }
}

const range = diffRange({ eventName: process.env.GITHUB_EVENT_NAME, event: event() });
const paths = range === null ? null : changedPaths(range);
const changed = paths === null ? true : productChanged(paths);

if (range === null) {
  console.log(`No diff range for a ${process.env.GITHUB_EVENT_NAME ?? 'nameless'} event, so every check runs.`);
} else if (paths !== null) {
  const forcing = productPaths(paths);
  console.log(`${range}: ${paths.length} path(s) changed, ${forcing.length} of them product.`);
  // Named, because "why did this run" is the only question anybody asks of this
  // job, and the answer is usually one path. Capped, so a large diff does not
  // print itself into the log for an answer nobody is in doubt about.
  for (const path of forcing.slice(0, 20)) console.log(`  ${path}`);
  if (forcing.length > 20) console.log(`  ... and ${forcing.length - 20} more`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `product_changed=${changed}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = changed
    ? 'This diff touches the product, so every mechanical check runs.'
    : 'This diff touches only `docs/`, `.claude/` and root-level Markdown, so the mechanical checks skip. Each still reports, as skipped.';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## What changed\n\n${summary}\n`);
}
