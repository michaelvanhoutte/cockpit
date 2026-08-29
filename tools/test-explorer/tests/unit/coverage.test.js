import { describe, expect, it } from 'vitest';
import { branchesNotTaken } from '../../src/analyze/coverage.js';

/** A minimal istanbul-shaped coverage map for one file, with one branch id. */
function mapWithBranch({ hitsPerPath, locations, loc }) {
  return {
    data: {
      '/abs/file.ts': {
        b: { 0: hitsPerPath },
        branchMap: { 0: { locations, loc } },
      },
    },
  };
}

describe('branchesNotTaken', () => {
  it('reports nothing when every path of a branch was taken', () => {
    const map = mapWithBranch({
      hitsPerPath: [5, 3],
      locations: [{ start: { line: 10 } }, { start: { line: 12 } }],
    });
    expect(branchesNotTaken(map, '/abs/file.ts')).toEqual([]);
  });

  it('reports a branch where every path is untaken', () => {
    const map = mapWithBranch({
      hitsPerPath: [0, 0],
      locations: [{ start: { line: 10 } }, { start: { line: 12 } }],
    });
    expect(branchesNotTaken(map, '/abs/file.ts')).toEqual([{ line: 10 }, { line: 12 }]);
  });

  it('reports only the untaken path of a partially-taken branch (an if with no else, tested only on the truthy side)', () => {
    // hitsPerPath = [5, 0]: the if-branch ran 5 times, the else-branch never ran.
    // A branch-id-level check (`some(n => n > 0)`) would see the 5 and report nothing;
    // this must still catch the untested path at index 1.
    const map = mapWithBranch({
      hitsPerPath: [5, 0],
      locations: [{ start: { line: 20 } }, { start: { line: 22 } }],
    });
    expect(branchesNotTaken(map, '/abs/file.ts')).toEqual([{ line: 22 }]);
  });

  it('falls back to the branch-level loc when a per-path location is missing', () => {
    const map = mapWithBranch({
      hitsPerPath: [0],
      locations: [undefined],
      loc: { start: { line: 30 } },
    });
    expect(branchesNotTaken(map, '/abs/file.ts')).toEqual([{ line: 30 }]);
  });

  it('returns null (not an empty array) when the file is not present in the coverage map — unmeasured is not the same fact as clean', () => {
    const map = mapWithBranch({ hitsPerPath: [0], locations: [{ start: { line: 1 } }] });
    expect(branchesNotTaken(map, '/abs/other-file.ts')).toBeNull();
  });

  it('matches a map key against a query path that uses a different separator', () => {
    // The istanbul provider (apps/api's Workers-pool tests) writes forward-slash keys regardless
    // of platform; the v8 provider writes the platform's native separator. On Windows those
    // disagree with each other and with path.join()'s backslash output — a lookup that requires
    // an exact string match would find v8's files and silently treat every istanbul-covered file
    // as unmeasured. Both directions must resolve to the same entry.
    const map = {
      data: {
        'C:/GitHub/Cockpit/apps/api/src/thing.ts': {
          b: { 0: [0] },
          branchMap: { 0: { locations: [{ start: { line: 7 } }] } },
        },
      },
    };
    expect(branchesNotTaken(map, 'C:\\GitHub\\Cockpit\\apps\\api\\src\\thing.ts')).toEqual([{ line: 7 }]);
  });
});
