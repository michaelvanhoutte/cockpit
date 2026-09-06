import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConcepts } from '../../src/analyze/concepts.js';
import { sourceFiles, workspacePackages } from '../../src/analyze/workspace.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The registry is checked-in configuration pointing at checked-in files, and
 * nothing notices when the two drift: `matchingConcepts` simply stops matching,
 * the file's coverage falls into `infrastructure`, and the area it belonged to
 * quietly reports less. Two patterns survived a rename that way through a full
 * test run, a typecheck and a green CI, surfacing only because a reviewer read
 * the JSON.
 *
 * Held against the file list the analyzer itself walks rather than against
 * `existsSync`, for two reasons. `existsSync` on a case-insensitive filesystem
 * accepts `itemrow.tsx` for `ItemRow.tsx`, which `globToRegExp` never matches —
 * so the check would pass on Windows over a pattern already broken there.
 * And a path outside any package's `src/` exists without the analyzer ever
 * seeing it, which is the same silent hole by another route.
 *
 * `repo` needs no guard of its own: a wrong root makes `workspacePackages`
 * throw at collection naming the `pnpm-workspace.yaml` it could not open, which
 * is louder than an assertion and cannot be confused with registry drift.
 *
 * Reading the real repository off disk is filesystem I/O, which the testing
 * skill puts at L2 — so this sits in tests/integration/ beside the fixture-repo
 * walk, not in tests/unit/ with the glob matcher it complements.
 */
describe('the area registry against the real repository', () => {
  it('leaves no pattern naming a file the analyzer never walks', () => {
    const walked = new Set(workspacePackages(repo).flatMap((pkg) => sourceFiles(repo, pkg)));
    const stale = [];
    for (const concept of loadConcepts()) {
      for (const pattern of concept.sourcePatterns) {
        // A pattern containing a glob is deliberately exempt. A concrete path
        // claims *this file exists*, so a rename must fail; a glob claims a
        // shape, and `apps/web/src/panels/**` means the same thing over a
        // directory somebody is about to fill as over a full one. The registry
        // already declares an area ahead of its code (an empty sourcePatterns
        // list), and failing an unmatched glob would turn that into a broken
        // build for no gain: a glob matching nothing moves no coverage, so
        // there is nothing for it to hide.
        if (pattern.includes('*')) continue;
        if (!walked.has(pattern)) stale.push(`${concept.key}: ${pattern}`);
      }
    }
    // Listed together rather than one failure at a time, since one rename
    // usually strands several patterns at once.
    expect(stale).toEqual([]);
  });
});
