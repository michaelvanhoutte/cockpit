//
// What the `E2E (F3)` job in .github/workflows/ci.yml runs: every walk (`full`)
// or only the walks whose outer `describe` names a product area that owns a
// changed file (`selected`) - "Run only the affected specs in CI's E2E (F3)
// job on a pull request" (issue 347), the browser tier's counterpart to
// scripts/lib/test-selection.mjs.
//
// The mapping is the area registry already in tools/test-explorer/concepts.json:
// each area's `sourcePatterns` place a source file, and its key is the outer
// `describe` title testing-strategy.md requires, so nothing new is kept.
//
// `full` for anything the registry cannot be trusted to attribute:
//
// - a push to `main`, or a pull request whose merge-base is unplaceable;
// - a changed file matching no area (the implicit `infrastructure` bucket), so
//   an incomplete registry can only over-run, never skip a walk;
// - the specs' own support code, the registry, the Playwright config, and every
//   path scripts/lib/test-selection.mjs forces every package for (a workflow,
//   the lockfile, any package.json, any tsconfig, anything outside a package);
// - a changed spec file whose walks the listing cannot place.
//
// A changed spec file selects the areas its own walks are written under, so
// adding a walk to `capture.test.ts` runs Capture without every other area.
//
// Pure: no git, no filesystem, no process. scripts/ci-e2e.mjs reads all of that.
//

import { isNonProduct } from './what-changed.mjs';
import { isOutsidePackages, isTsconfig } from './test-selection.mjs';
import { matchingConcepts } from '../../tools/test-explorer/src/analyze/concepts.js';

const SPECS = 'tests/e2e/';
const SUPPORT = 'tests/e2e/support/';
const REGISTRY = 'tools/test-explorer/concepts.json';
const CONFIG = 'playwright.config.ts';

/** The rule that makes `path`, changed, useless as an answer to "which walks does this touch", or null where it forces nothing. */
function ruleForcingFull(path, packages) {
  if (path.startsWith(SUPPORT) || path === REGISTRY || path === CONFIG) return 'e2e support, registry or config';
  if (isTsconfig(path)) return 'any tsconfig';
  // A spec file sits outside every package; it is placed by its own walks below.
  if (path.startsWith(SPECS)) return null;
  return isOutsidePackages(path, packages) ? 'outside every package' : null;
}

/** A `full` plan, its `reason` the sentence the job prints and `forced` the `{ rule, path }` the record keeps (scripts/lib/e2e-record.mjs); `path` is null where an event or an unreadable diff is to blame, not a file. */
function full(rule, path, reason) {
  return { mode: 'full', reason, forced: { rule, path } };
}

/** `--grep` for a set of areas: Playwright matches it against a walk's title path joined with spaces - project, file, then the outer `describe` - so an area is what follows the file. */
export function grepFor(areas) {
  const escaped = areas.map((area) => area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `\\.test\\.ts (?:${escaped.join('|')}) `;
}

/**
 * @param {object} input
 * @param {string} input.event `GITHUB_EVENT_NAME`
 * @param {string | null} input.mergeBase
 * @param {string[]} input.changedFiles repo-relative, as `git diff --name-only` prints them
 * @param {{ key: string, sourcePatterns: string[] }[]} input.concepts the registry
 * @param {{ area: string | null, where: string }[]} input.walks the tier's listing (`walksIn`); `where` is relative to tests/e2e
 * @param {{ name: string, dir: string }[]} input.packages the workspace packages
 * @returns {{ mode: 'full', reason: string, forced: { rule: string, path: string | null } } | { mode: 'selected', areas: string[], grep: string | null, changedBy: Record<string, string> }}
 *   `grep` is null when the areas own no walk at all, so there is nothing to run;
 *   `changedBy` names, per selected area, the first changed file that selected it
 */
export function planE2eRun({ event, mergeBase, changedFiles = [], concepts, walks, packages }) {
  if (!concepts || !walks || !packages) throw new Error('planE2eRun needs the registry, the tier’s listing and the workspace package list.');
  if (event !== 'pull_request') return event === 'push' ? full('push to main', null, 'push to main') : full('not a pull request', null, 'not a pull request');
  if (!mergeBase) return full('diff unreadable', null, 'no merge-base to diff against');

  const productFiles = changedFiles.filter((path) => !isNonProduct(path));
  if (productFiles.length === 0) return full('no product file in the diff', null, 'no product file in the diff');

  const changedBy = new Map();
  for (const path of productFiles) {
    const rule = ruleForcingFull(path, packages);
    if (rule) return full(rule, path, `${path} is not attributable to an area`);

    if (path.startsWith(SPECS)) {
      const own = walks.filter((walk) => `${SPECS}${walk.where}` === path);
      if (own.length === 0 || own.some((walk) => walk.area === null)) return full('spec with no area', path, `${path} has no area to place its walks under`);
      for (const walk of own) if (!changedBy.has(walk.area)) changedBy.set(walk.area, path);
      continue;
    }

    const owners = matchingConcepts(concepts, path);
    if (owners.length === 0) return full('owned by no concept', path, `${path} matches no area`);
    for (const key of owners) if (!changedBy.has(key)) changedBy.set(key, path);
  }

  const withWalks = new Set(walks.map((walk) => walk.area));
  const selected = [...changedBy.keys()].filter((area) => withWalks.has(area)).sort();
  return { mode: 'selected', areas: selected, grep: selected.length > 0 ? grepFor(selected) : null, changedBy: Object.fromEntries(selected.map((area) => [area, changedBy.get(area)])) };
}
