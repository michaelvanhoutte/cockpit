import { describe, expect, it } from 'vitest';
import { summarise } from '../../src/model.js';

function node({ key, rules = [], filesNothingRuns = [], branchesNothingTakes = [], children = [] }) {
  return { key, label: key, counts: {}, rules, filesNothingRuns, branchesNothingTakes, children };
}

describe('summarise', () => {
  it('sums rules and dedupes gaps a single file/branch only owns once, across sibling nodes', () => {
    // concepts.json deliberately lets one file back more than one feature area (e.g. Capture and
    // Triage both own apps/api/src/db/repo.ts) — the same untested file must not be counted twice
    // just because two areas both point at it.
    const model = {
      tree: [
        node({
          key: 'Capture',
          rules: [{}],
          filesNothingRuns: [{ file: 'apps/api/src/db/repo.ts' }],
          branchesNothingTakes: [{ file: 'apps/web/src/ItemRow.tsx', line: 45 }],
        }),
        node({
          key: 'Triage',
          rules: [{}, {}],
          filesNothingRuns: [{ file: 'apps/api/src/db/repo.ts' }, { file: 'apps/api/src/db/schema.ts' }],
          branchesNothingTakes: [{ file: 'apps/web/src/ItemRow.tsx', line: 45 }, { file: 'apps/web/src/ItemRow.tsx', line: 52 }],
        }),
      ],
    };

    expect(summarise(model)).toEqual({ rules: 3, filesNothingRuns: 2, branchesNothingTakes: 2 });
  });

  it('walks nested children, not just root nodes', () => {
    const model = {
      tree: [
        node({
          key: 'Dashboards',
          filesNothingRuns: [{ file: 'a.ts' }],
          children: [node({ key: 'Panels', filesNothingRuns: [{ file: 'b.ts' }] })],
        }),
      ],
    };

    expect(summarise(model).filesNothingRuns).toBe(2);
  });

  it('counts both uncovered paths on one line, so the masthead is never smaller than a row', () => {
    // coverage.js keys a branch gap by line alone, so an if/else with neither
    // path taken is two entries that share a file:line. The masthead and each
    // row's subtree total must count those the same way, or the total above
    // the tree prints smaller than a row inside it.
    const both = [
      { file: 'apps/web/src/components/Menu.tsx', line: 12 },
      { file: 'apps/web/src/components/Menu.tsx', line: 12 },
    ];
    const model = {
      tree: [
        node({ key: 'Dashboards', branchesNothingTakes: both, children: [node({ key: 'Panels', branchesNothingTakes: both })] }),
      ],
    };

    expect(summarise(model).branchesNothingTakes).toBe(2);
  });

  it('treats a null branchesNothingTakes (no coverage data) as contributing nothing, not as a crash', () => {
    const model = { tree: [node({ key: 'Capture', branchesNothingTakes: null })] };
    expect(summarise(model).branchesNothingTakes).toBe(0);
  });
});
