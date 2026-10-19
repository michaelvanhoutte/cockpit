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
// A changed file is placed in this order ("Place a changed file by its
// importers in the E2E (F3) selection", issue 1282, of "Make the E2E (F3)
// selection fire: place a changed file by what imports it", issue 1275):
//
// 1. A registered file takes its areas from the registry alone; its importers
//    are not consulted.
// 2. Any other file is followed up its importers (scripts/lib/import-graph.mjs),
//    nearest first, until a registered file is reached, and takes that file's
//    areas; several at the nearest depth give the union.
// 3. A file the browser job loads (a root, or a stack input) reached before any
//    registered file is a full run, owned by no area. Where a root and a
//    registered file sit at the same depth neither is first, and the root wins:
//    over-running is the safe side.
// 4. Nothing reached selects no walk, which is what another tier's test file,
//    markdown anywhere and tooling the job never runs come to. The plan names
//    such a file in `unplaced`, so a miss through a computed import is readable.
//
// `full` for anything the registry and the graph cannot be trusted to attribute:
//
// - a push to `main`, or a pull request whose merge-base is unplaceable;
// - a workflow or action, the lockfile, any package.json, any tsconfig, the
//   registry, the specs' own support code, the Playwright config and a stack
//   input (what the stack starts from that no import names);
// - a changed spec file whose walks the listing cannot place.
//
// A changed spec file selects the areas its own walks are written under, so
// adding a walk to `capture.test.ts` runs Capture without every other area.
//
// Pure: no git, no filesystem, no process. scripts/ci-e2e.mjs reads all of that.
//

import { basename } from 'node:path';

import { isNonProduct } from './what-changed.mjs';
import { isTsconfig, SPECS } from './test-selection.mjs';
import { matchingConcepts } from '../../tools/test-explorer/src/analyze/concepts.js';

const SUPPORT = 'tests/e2e/support/';
const REGISTRY = 'tools/test-explorer/concepts.json';
const CONFIG = 'playwright.config.ts';
const LOCKFILE = 'pnpm-lock.yaml';
const WORKFLOWS = '.github/';

/**
 * What the browser job loads that a changed file can be reached from. A name
 * ending in `/` is a folder and stands for every file under it. Each is
 * asserted to exist by scripts/lib/e2e-selection.test.mjs, so a rename fails
 * there instead of quietly turning a root into a file nothing reaches.
 */
export const ROOTS = [
  SPECS, // the walks
  CONFIG,
  'scripts/ci-e2e.mjs', // the job's own step
  'scripts/e2e-ceilings.mjs', // the job's budget step
  'scripts/e2e-stack.mjs', // the stack the walks drive
  'apps/web/src/main.tsx', // the web entry
  'apps/api/tests/e2e-worker.ts', // the Worker entries scripts/e2e-stack.mjs hands Wrangler
  'apps/harness-monitor/tests/e2e-worker.ts',
];

/**
 * What the stack starts from that no import names, so a change is a full run
 * naming it. Asserted to exist like `ROOTS`.
 */
export const STACK_INPUTS = [
  'apps/api/migrations/',
  'apps/harness-monitor/migrations/',
  'apps/api/seed.sql',
  'apps/api/wrangler.jsonc',
  'apps/harness-monitor/wrangler.jsonc',
  'apps/web/vite.config.ts',
  'apps/web/index.html',
  // Inlined into the page by vite.config.ts through `new URL(...)`, which the graph does not read as an import.
  'apps/web/src/appearanceBoot.js',
];

const within = (path, list) => list.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));

/** The rule that makes `path`, changed, useless as an answer to "which walks does this touch", or null where it forces nothing. */
function ruleForcingFull(path) {
  if (path.startsWith(SUPPORT) || path === REGISTRY || path === CONFIG) return 'e2e support, registry or config';
  if (path.startsWith(WORKFLOWS)) return 'workflow or action';
  if (path === LOCKFILE) return 'lockfile';
  if (basename(path) === 'package.json') return 'any package.json';
  if (isTsconfig(path)) return 'any tsconfig';
  if (within(path, STACK_INPUTS)) return 'stack input';
  return null;
}

/** A `full` plan, its `reason` the sentence the job prints and `forced` the `{ rule, path }` the record keeps (scripts/lib/e2e-record.mjs); `path` is null where an event or an unreadable diff is to blame, not a file. */
function full(rule, path, reason) {
  return { mode: 'full', reason, forced: { rule, path } };
}

const LOADED = 'loaded by the job, owned by no area';

/** A file the job loads without any area owning it: a root, or a stack input. A registered file is never one. */
const isLoaded = (path) => within(path, ROOTS) || within(path, STACK_INPUTS);

/**
 * Where `path` is placed, which the registry cannot do: its nearest registered
 * importers, a loaded file reached first, or nothing.
 * @returns {{ areas: Map<string, string> } | { loaded: string } | { areas: null }}
 *   `areas` maps each area to the registered file that placed it
 */
function placeByImporters(path, concepts, graph) {
  const seen = new Set([path]);
  let frontier = [path];
  while (frontier.length > 0) {
    const level = new Set();
    for (const file of frontier) for (const importer of graph.importersOf(file)) if (!seen.has(importer)) level.add(importer);
    for (const file of level) seen.add(file);
    const next = [...level].sort();

    const registered = new Map();
    for (const file of next) for (const key of matchingConcepts(concepts, file)) if (!registered.has(key)) registered.set(key, file);
    const loaded = next.find((file) => isLoaded(file) && matchingConcepts(concepts, file).length === 0);
    if (loaded) return { loaded };
    if (registered.size > 0) return { areas: registered };
    frontier = next;
  }
  return { areas: null };
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
 * @param {{ importersOf: (path: string) => string[] }} input.graph who imports a file (scripts/lib/import-graph.mjs)
 * @returns {{ mode: 'full', reason: string, forced: { rule: string, path: string | null } } | { mode: 'selected', areas: string[], grep: string | null, changedBy: Record<string, string>, via: Record<string, string>, unplaced: string[] }}
 *   `grep` is null when the areas own no walk at all, so there is nothing to run;
 *   `changedBy` names, per selected area, the first changed file that selected it;
 *   `via` names, for an area a changed file reached through its importers, the registered file that placed it;
 *   `unplaced` lists the changed files that selected no walk because nothing imports them
 */
export function planE2eRun({ event, mergeBase, changedFiles = [], concepts, walks, graph }) {
  if (!concepts || !walks || !graph) throw new Error('planE2eRun needs the registry, the tier’s listing and the import graph.');
  if (event !== 'pull_request') return event === 'push' ? full('push to main', null, 'push to main') : full('not a pull request', null, 'not a pull request');
  if (!mergeBase) return full('diff unreadable', null, 'no merge-base to diff against');

  const productFiles = changedFiles.filter((path) => !isNonProduct(path));
  if (productFiles.length === 0) return full('no product file in the diff', null, 'no product file in the diff');

  const changedBy = new Map();
  const via = new Map();
  const unplaced = [];
  const take = (area, changed, placedBy) => {
    if (changedBy.has(area)) return;
    changedBy.set(area, changed);
    if (placedBy) via.set(area, placedBy);
  };

  for (const path of productFiles) {
    const rule = ruleForcingFull(path);
    if (rule) return full(rule, path, `${path} is not attributable to an area`);

    if (path.startsWith(SPECS)) {
      const own = walks.filter((walk) => `${SPECS}${walk.where}` === path);
      if (own.length === 0 || own.some((walk) => walk.area === null)) return full('spec with no area', path, `${path} has no area to place its walks under`);
      for (const walk of own) take(walk.area, path, null);
      continue;
    }

    const owners = matchingConcepts(concepts, path);
    if (owners.length > 0) {
      for (const key of owners) take(key, path, null);
      continue;
    }

    if (within(path, ROOTS)) return full(LOADED, path, `${path} is loaded by the job and owned by no area`);
    const placed = placeByImporters(path, concepts, graph);
    if (placed.loaded) return full(LOADED, placed.loaded, `${path} is loaded by the job through ${placed.loaded}, which no area owns`);
    if (placed.areas === null) unplaced.push(path);
    else for (const [area, registered] of placed.areas) take(area, path, registered);
  }

  const withWalks = new Set(walks.map((walk) => walk.area));
  const selected = [...changedBy.keys()].filter((area) => withWalks.has(area)).sort();
  return {
    mode: 'selected',
    areas: selected,
    grep: selected.length > 0 ? grepFor(selected) : null,
    changedBy: Object.fromEntries(selected.map((area) => [area, changedBy.get(area)])),
    via: Object.fromEntries(selected.filter((area) => via.has(area)).map((area) => [area, via.get(area)])),
    unplaced,
  };
}
