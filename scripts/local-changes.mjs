#!/usr/bin/env node
//
// What CLAUDE.md's Tests table calls the change on this branch - the
// classifier scripts/lib/what-changed.mjs already answers for a CI diff
// (`scripts/what-changed.mjs`), asked instead of a working tree, so a
// session reads its answer rather than judging it by eye ("Scale a session's
// own checks to what the change touches, as CI already does", issue 372).
//
// Usage: node scripts/local-changes.mjs
//
// `git diff --merge-base <against>`, with no second ref, diffs the
// merge-base against the working tree in one call - committed and staged or
// unstaged changes all count, because the question is what this push is
// about to be, not what has already landed. The same fallback
// scripts/lib/writing-rules.test.mjs uses for the same reason: `origin/main`
// where a fetch has kept it current, `main` where only the local branch
// exists.
//
// `git diff` alone never lists a file nothing has `git add`ed yet, so
// `git ls-files --others --exclude-standard` runs beside it - a new file a
// session just wrote and has not staged is exactly the case the safe
// direction below exists for.
//
// Anything this cannot read - no `main` to diff against, `pnpm -r list`
// failing - answers 'product', the direction that costs a run rather than a
// merge, the same as every failure classify() (scripts/lib/what-changed.mjs)
// already answers that way.
//

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { changeClass, pathsFromDiff, printable, productPaths } from './lib/what-changed.mjs';
import { testablePackages } from './lib/workspace.mjs';
import { pnpmWorkspaceList } from './lib/processes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Files in the working tree `git add` has never seen - `null` where the query itself failed. */
function untrackedPaths() {
  const result = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? pathsFromDiff(result.stdout) : null;
}

/** Every path this branch has touched, committed or not - `null` where the untracked list could not be read, or neither `origin/main` nor `main` could be diffed against. */
function changedPaths() {
  const untracked = untrackedPaths();
  if (untracked === null) return null;
  for (const against of ['origin/main', 'main']) {
    const result = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', '--merge-base', against], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return [...new Set([...pathsFromDiff(result.stdout), ...untracked])];
  }
  return null;
}

function fallback(reason) {
  console.error(printable(`${reason} So this answers 'product changed'.`));
  console.log('product changed');
}

const paths = changedPaths();
if (paths === null) {
  fallback('Could not diff against origin/main or main.');
  process.exit(0);
}

// The workspace's package list is only needed to tell 'tests' from
// 'product' - never for 'docs', which productPaths alone already answers -
// so a docs-only push, the cheapest row in CLAUDE.md's Tests table, never
// pays for the `pnpm -r list` this otherwise costs on every invocation. An
// empty diff is excluded on purpose: changeClass answers that 'product',
// not 'docs' (its own doc comment gives the reason), and this has to agree.
if (paths.length > 0 && productPaths(paths).length === 0) {
  console.log('documentation only');
  process.exit(0);
}

let packages;
try {
  packages = testablePackages(pnpmWorkspaceList(root), (pkgPath) => JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')), root);
} catch (error) {
  fallback(`Could not read the workspace: ${error.message}.`);
  process.exit(0);
}

const result = changeClass({ paths, packages });

if (result.class === 'tests') console.log(`tests only (${result.packages.join(', ')})`);
else console.log('product changed');
