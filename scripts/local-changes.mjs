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
// merge-base against the working tree in one call - committed and
// uncommitted changes both count, because the question is what this push is
// about to be, not what has already landed. The same fallback
// scripts/lib/writing-rules.test.mjs uses for the same reason: `origin/main`
// where a fetch has kept it current, `main` where only the local branch
// exists.
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

import { changeClass, pathsFromDiff, printable } from './lib/what-changed.mjs';
import { testablePackages } from './lib/workspace.mjs';
import { pnpmWorkspaceList } from './lib/processes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every path this branch has touched, committed or not - `null` where neither `origin/main` nor `main` could be diffed against. */
function changedPaths() {
  for (const against of ['origin/main', 'main']) {
    const result = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', '--merge-base', against], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return pathsFromDiff(result.stdout);
  }
  return null;
}

function fallback(reason) {
  console.error(printable(`${reason} so this answers 'product changed'.`));
  console.log('product changed');
}

let packages;
try {
  packages = testablePackages(pnpmWorkspaceList(root), (pkgPath) => JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')), root);
} catch (error) {
  fallback(`Could not read the workspace: ${error.message}.`);
  process.exit(0);
}

const paths = changedPaths();
if (paths === null) {
  fallback('Could not diff against origin/main or main,');
  process.exit(0);
}

const result = changeClass({ paths, packages });

if (result.class === 'docs') console.log('documentation only');
else if (result.class === 'tests') console.log(`tests only (${result.packages.join(', ')})`);
else console.log('product changed');
