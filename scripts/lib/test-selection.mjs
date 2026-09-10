//
// What the Test job in .github/workflows/ci.yml runs, per package: every test
// (`full`) or only what depends on what changed since the merge-base with
// `main` (`changed`, via Vitest's own `--changed <ref>`).
//
// A pull request gets `changed` by default - the vitest.config.ts files
// between them cover more test files than any one diff usually touches, which
// is the cost issue 346 ("Run only the affected tests in CI's Test job on a
// pull request") exists to cut. `main` always gets `full` - why that still
// satisfies testing-strategy.md's "Definition of done for agents" section
// (§6) is in ci.yml's own comment on this job.
//
// A change nothing in the import graph can be trusted to attribute forces
// `full`. Two different reasons force it, at two different scopes:
//
// - **Anything outside every package's own directory** - the lockfile, any
//   package.json (a resolution or dependency change, not itself a node in
//   the import graph Vitest walks), a workflow or the composite action every
//   job's toolchain setup depends on, or any future root-level config file -
//   forces every package. Derived from `packages` itself rather than a list
//   of paths to recognise, so a new kind of root file is covered the day it
//   is added rather than the day someone remembers to list it here - a
//   hardcoded `PACKAGES` array already went stale exactly that way once (see
//   scripts/lib/workspace.mjs's own comment).
// - A **tsconfig anywhere**, root or nested, forces every package too - kept
//   as its own check rather than folded into the rule above, because a
//   tsconfig can `extends` another package's and so isn't safely attributable
//   to only the package it lives under.
// - A package's own `vitest.config.ts`, its own `package.json`, or a
//   migration under its `migrations/` forces only that package.
//
// Vitest's own `--changed` is what walks the import graph from there; this
// only decides which packages get to use it (already exercised by Vitest's
// own suite - see the issue's "Cut" note).
//
// Pure: no git, no filesystem, no process.env. scripts/ci-test.mjs reads all of
// that and calls this once, so the decision is asserted by `node --test`
// without a checkout to compute a real merge-base against, and without a real
// workspace to discover `packages` from (scripts/lib/workspace.mjs).
//

import { basename } from 'node:path';

/** A changed path no package's own directory covers - the lockfile, any package.json, a workflow, and anything else at that altitude. */
function isOutsidePackages(path, packages) {
  return !packages.some((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`));
}

/** A tsconfig anywhere - it can `extends` another package's, so its reach is never provably local. */
function isTsconfig(path) {
  return /^tsconfig.*\.json$/.test(basename(path));
}

/** A changed path that only speaks for one package's own suite. */
function forcesThisPackageFull(path, dir) {
  if (path === `${dir}/vitest.config.ts`) return true;
  if (path === `${dir}/package.json`) return true;
  if (path.startsWith(`${dir}/migrations/`)) return true;
  return false;
}

/**
 * Which packages run in full and which run only what changed.
 *
 * `packages` is required - `{ name, dir }[]`, what scripts/lib/workspace.mjs's
 * testablePackages discovers - rather than defaulted to a list here, so
 * nothing in this module can go stale the way a hardcoded array of packages
 * already did once (see workspace.mjs's own comment). It also doubles as the
 * boundary `isOutsidePackages` reasons about.
 *
 * `changedFiles` and `mergeBase` are ignored - and every package forced to
 * `full` - for anything but a `pull_request` event, and where `mergeBase` is
 * falsy: a push to `main` always runs everything, and an unplaceable
 * merge-base (including a failed `git diff` computing `changedFiles` -
 * scripts/ci-test.mjs treats that the same as an unplaceable one) is a reason
 * to run everything rather than guess at a diff.
 */
export function planTestRun({ event, mergeBase, changedFiles = [], packages }) {
  if (!packages) throw new Error('planTestRun needs the workspace package list (scripts/lib/workspace.mjs).');

  const forceAll =
    event !== 'pull_request' ||
    !mergeBase ||
    changedFiles.some((path) => isTsconfig(path) || isOutsidePackages(path, packages));

  return {
    packages: packages.map((pkg) => ({
      ...pkg,
      mode: forceAll || changedFiles.some((path) => forcesThisPackageFull(path, pkg.dir)) ? 'full' : 'changed',
    })),
  };
}
