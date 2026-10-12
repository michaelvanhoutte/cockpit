import { describe, expect, it } from 'vitest';
import { isExcluded } from '../../src/excluded-files';

describe('Harness Monitor', () => {
  describe("a pull request's size leaves out lockfiles, snapshots and generated files, and nothing else", () => {
    it.each([
      { situation: 'the lockfile at the root', path: 'pnpm-lock.yaml', left: true },
      { situation: 'a lockfile in a nested package', path: 'poc/rich-text-spike/pnpm-lock.yaml', left: true },
      { situation: 'a snapshot file', path: 'apps/web/tests/unit/__snapshots__/card.test.ts.snap', left: true },
      { situation: 'a .snap file outside a snapshots folder', path: 'apps/web/tests/card.snap', left: true },
      { situation: 'a file under a snapshots folder', path: 'apps/web/tests/__snapshots__/card.txt', left: true },
      { situation: 'a generated file the list names', path: 'apps/api/worker-configuration.d.ts', left: true },
      { situation: 'a generated file the list names by its pattern', path: 'apps/web/src/routeTree.gen.ts', left: true },
      { situation: 'source whose name only contains "lock"', path: 'apps/api/src/lock.ts', left: false },
      { situation: 'a file named like a snapshot folder but not inside one', path: 'apps/web/src/snapshots.ts', left: false },
      { situation: 'ordinary source', path: 'apps/harness-monitor/src/linking.ts', left: false },
      { situation: 'a file whose name merely ends like a lockfile', path: 'docs/not-pnpm-lock.yaml.md', left: false },
    ])('$situation: left out is $left', ({ path, left }) => {
      expect(isExcluded(path)).toBe(left);
    });

    it.each([
      { situation: 'a pattern with a slash is anchored at the root', patterns: ['docs/*.md'], path: 'docs/a.md', other: 'x/docs/a.md' },
      { situation: 'a double star crosses folders', patterns: ['gen/**/out.ts'], path: 'gen/a/b/out.ts', other: 'src/gen/a/out.ts' },
      { situation: 'a trailing slash names folders only', patterns: ['build/'], path: 'x/build/y.js', other: 'x/build' },
      { situation: 'a leading slash anchors at the root', patterns: ['/gen.ts'], path: 'gen.ts', other: 'src/gen.ts' },
    ])('$situation', ({ patterns, path, other }) => {
      expect(isExcluded(path, patterns)).toBe(true);
      expect(isExcluded(other, patterns)).toBe(false);
    });
  });
});
