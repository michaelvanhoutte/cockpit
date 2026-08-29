/**
 * "Branches nothing takes": docs/test-explorer-spec.md §6.3.
 *
 * Unlike rule extraction and "files nothing runs", this needs the suite to
 * have actually run with v8 coverage instrumentation — there is no way to
 * know which branch a real run took without one. Each package's Vitest
 * config is expected to write `coverage/coverage-final.json`
 * (`coverage: { provider: 'v8', all: true, reporter: ['json'] }`); this
 * module looks for that conventional path under every workspace package and
 * merges what it finds with istanbul-lib-coverage.
 *
 * No coverage config exists yet on any branch as of this writing (the
 * per-level Vitest configs are still landing — docs/test-explorer-spec.md
 * §3). So today this always returns `available: false`, and every concept's
 * branchesNothingTakes renders as "unknown" rather than a false zero. That is
 * the intended degradation, not a bug: a missing measurement must never look
 * like a clean one.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * @param {string} repo absolute repo root
 * @param {string[]} packageDirs repo-relative package directories
 * @returns {{ available: boolean, map: import('istanbul-lib-coverage').CoverageMap | null, warnings: string[] }}
 */
export function loadMergedCoverage(repo, packageDirs) {
  const warnings = [];
  const files = [];
  for (const dir of packageDirs) {
    const file = path.join(repo, dir, 'coverage', 'coverage-final.json');
    if (existsSync(file)) files.push(file);
  }

  if (files.length === 0) {
    return { available: false, map: null, warnings };
  }

  let createCoverageMap;
  try {
    ({ createCoverageMap } = require('istanbul-lib-coverage'));
  } catch {
    warnings.push('coverage-final.json found but istanbul-lib-coverage is not installed; run `pnpm install`.');
    return { available: false, map: null, warnings };
  }

  const map = createCoverageMap({});
  for (const file of files) {
    try {
      map.merge(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      warnings.push(`could not read ${path.relative(repo, file)}: ${err.message}`);
    }
  }
  return { available: true, map, warnings };
}

/**
 * Reports every untaken *path* of every branch, not just branches where every path was untaken.
 * `fileCoverage.b[branchId]` is one hit count per path of that branch (e.g. `[5, 0]` for an
 * if/else where only the truthy path ran) — checking `hitsPerPath.some(n => n > 0)` against the
 * whole branch would miss that `0`, which is exactly the kind of gap this column exists to
 * surface: an `if` with no `else` tested only on the taken side. Each untaken path is reported
 * at its own location (`branchMap[branchId].locations[idx]`), falling back to the branch's overall
 * location if a per-path one isn't present.
 *
 * `null` and `[]` are different facts here and callers must not conflate them: `null` means this
 * *file* has no entry in the merged map at all — excluded by a package's coverage config (every
 * package's vitest config excludes `**\/index.ts`), or owned by a package that never ran
 * `test:coverage` in the first place (e.g. packages/connector-sdk has no coverage script) — so
 * nothing about its branches is known. `[]` means the file *is* in the map and every branch path
 * it has was genuinely taken. Only the caller can decide what to do with "unmeasured" (surface it,
 * skip it, warn about it); silently treating it as `[]` would render an unmeasured file exactly
 * like a clean one, which is the same "missing measurement must never look like a clean one"
 * invariant model.js documents for the workspace-wide `coverageAvailable` flag, just at the level
 * of one file instead of the whole run.
 *
 * Looks the file up by a path-separator-normalized key, not `map.data[absFile]` directly: the v8
 * provider (apps/web, packages/shared) writes this platform's native separator, but the istanbul
 * provider (apps/api, instrumenting inside the Workers pool) writes forward slashes regardless of
 * platform. On Windows those disagree — a direct lookup would find every v8 file and silently miss
 * every istanbul one, which is indistinguishable from "genuinely unmeasured" without this fix.
 *
 * @param {import('istanbul-lib-coverage').CoverageMap} map
 * @param {string} absFile
 * @returns {{ file: string, line: number }[] | null} branch-path locations never taken, or null if
 *   the file has no coverage data at all
 */
export function branchesNotTaken(map, absFile) {
  const key = normalizedKeys(map).get(normalizeSeparators(absFile));
  const fileCoverage = key !== undefined ? map.data[key] : undefined;
  if (!fileCoverage) return null;
  const out = [];
  for (const [branchId, hitsPerPath] of Object.entries(fileCoverage.b)) {
    const branch = fileCoverage.branchMap[branchId];
    if (!branch) continue;
    hitsPerPath.forEach((hits, idx) => {
      if (hits > 0) return;
      const loc = branch.locations?.[idx] ?? branch.loc;
      if (loc) out.push({ line: loc.start.line });
    });
  }
  return out;
}

function normalizeSeparators(p) {
  return p.split('\\').join('/');
}

/** One normalized-key -> real-key index per map, built once and reused across every file lookup
 *  (this runs once per source file per concept, and the same map is queried repeatedly). */
const keyIndexCache = new WeakMap();

function normalizedKeys(map) {
  let index = keyIndexCache.get(map);
  if (!index) {
    index = new Map();
    for (const key of Object.keys(map.data)) index.set(normalizeSeparators(key), key);
    keyIndexCache.set(map, index);
  }
  return index;
}
