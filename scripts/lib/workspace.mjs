//
// Which workspace packages the Test job (.github/workflows/ci.yml) has to
// know about at all: every package pnpm's own workspace listing reports,
// narrowed to the ones that declare a "test:coverage" script - what
// scripts/ci-test.mjs actually runs per package (instrumented, so the suite
// runs once for both this gate and test-explorer's coverage columns, per
// "Run the suite once in CI, not once to gate and once to measure", issue
// 289), and the same set `pnpm test:coverage` ran before scripts/ci-test.mjs
// took over the Test job's step, per "Run only the affected tests in CI's
// Test job on a pull request" (issue 346).
//
// A hand-maintained list was tried first and was wrong the moment it was
// written: `tools/ci-stability` and `tools/test-explorer` already carry their
// own real suites, and a literal array naming only `packages/shared`,
// `apps/api` and `apps/web` drops both from CI silently - on every push to
// `main` as well as every pull request, since nothing else in ci.yml runs
// either package's own script. Discovering the set from pnpm itself is what
// keeps a future package from going the same way.
//
// `pnpmList` and `readManifest` are arguments rather than a `pnpm` call and a
// filesystem read made here, so this is asserted by `node --test` against
// fixture data instead of the real workspace - scripts/ci-test.mjs supplies
// the real ones.
//

import { relative, sep, posix } from 'node:path';

/**
 * `{ name, dir }` for every package in `pnpmList` (parsed `pnpm -r list
 * --depth -1 --json` output) that declares its own "test:coverage" script.
 * `readManifest(pkg.path)` returns that package's parsed package.json.
 * `dir` is given relative to `root`, in POSIX form regardless of the host
 * OS - the same shape `git diff --name-only` itself always emits, which is
 * what scripts/lib/test-selection.mjs compares it against.
 *
 * Skips the workspace root, which `pnpm -r list` reports alongside every real
 * package: identified by `pkg.path` resolving to `root` itself (`version` is
 * optional in a real package.json too, so that field is not what tells the
 * root apart - the same "assumed a manifest shape rather than checked the
 * one property that's actually guaranteed" mistake this module exists to
 * avoid making about the package *list*).
 */
export function testablePackages(pnpmList, readManifest, root) {
  const found = [];
  for (const pkg of pnpmList) {
    if (relative(root, pkg.path) === '') continue;
    const manifest = readManifest(pkg.path);
    if (!manifest?.scripts?.['test:coverage']) continue;
    found.push({ name: pkg.name, dir: relative(root, pkg.path).split(sep).join(posix.sep) });
  }
  return found;
}
