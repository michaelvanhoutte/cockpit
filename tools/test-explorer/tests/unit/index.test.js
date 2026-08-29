import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze/index.js';
import { walkTree } from '../../src/model.js';

/**
 * Builds a minimal synthetic repo under a temp directory and runs the real
 * analyzer against it end to end — the orchestrator in analyze/index.js has
 * no other direct coverage, and this is the level that can actually exercise
 * it: workspace discovery, rule extraction, import-reach and the registry
 * check all only make sense wired together against a real file tree.
 */
function writeFixtureRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'test-explorer-fixture-'));
  writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

  const pkg = path.join(repo, 'packages/demo');
  mkdirSync(path.join(pkg, 'src'), { recursive: true });
  mkdirSync(path.join(pkg, 'tests/unit'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@demo/demo', exports: { '.': './src/index.ts' } }));

  // Two source files: one genuinely imported and exercised by the test below,
  // one imported ONLY via an inline `type` specifier — real per §2's fix,
  // markReached must NOT count that as "reached".
  writeFileSync(path.join(pkg, 'src/index.ts'), 'export const noop = 0;\n');
  writeFileSync(path.join(pkg, 'src/thing.ts'), 'export function capture() { return 1; }\nexport interface Foo {}\n');
  writeFileSync(path.join(pkg, 'src/untouched.ts'), 'export const untouched = 1;\n');

  writeFileSync(
    path.join(pkg, 'tests/unit/thing.test.ts'),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { capture } from '../../src/thing.js';",
      "import { type Foo } from '../../src/untouched.js';",
      '',
      "describe('Capture', () => {",
      "  describe('captures something', () => {",
      "    it('returns 1', () => { expect(capture()).toBe(1); });",
      '  });',
      '});',
    ].join('\n'),
  );

  return repo;
}

function findNode(tree, key) {
  for (const node of walkTree(tree)) {
    if (node.key === key) return node;
  }
  return undefined;
}

describe('analyze (end to end against a fixture repo)', () => {
  let repo;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('extracts the rule at the right level, resolves the real import as reached, and leaves the type-only import unreached', () => {
    repo = writeFixtureRepo();
    const model = analyze(repo);

    expect(model.warnings.some((w) => w.includes('Capture'))).toBe(false); // 'Capture' is a registered area, no warning
    expect(model.unregisteredAreas).toEqual([]);

    const capture = findNode(model.tree, 'Capture');
    expect(capture.rules).toHaveLength(1);
    expect(capture.rules[0].statement).toBe('captures something');
    expect(capture.rules[0].level).toBe('L1');
    expect(capture.counts.L1).toBe(1);
    expect(capture.counts.F1).toBe(0);

    // Neither fixture source file matches a real concept's sourcePatterns (those are the actual
    // repo's paths), so both fall into 'infrastructure' by the same file-resolution rules.js §5
    // uses for the real repo — that's what lets this fixture test the reach logic in isolation.
    const infra = findNode(model.tree, 'infrastructure');
    // thing.ts is imported for real (a value import) -> reached, not in filesNothingRuns.
    expect(infra.filesNothingRuns).not.toContain('packages/demo/src/thing.ts');
    // untouched.ts is imported ONLY via `import { type Foo }` -> not reached, IS in filesNothingRuns.
    expect(infra.filesNothingRuns).toContain('packages/demo/src/untouched.ts');
  });

  it('reports a describe naming an unregistered feature area, even with no cases written yet', () => {
    repo = writeFixtureRepo();
    writeFileSync(
      path.join(repo, 'packages/demo/tests/unit/typo.test.ts'),
      ["import { describe } from 'vitest';", "describe('Trige', () => { describe('not written yet', () => {}); });"].join('\n'),
    );

    const model = analyze(repo);
    expect(model.unregisteredAreas).toEqual(['Trige']);
  });

  it('leaves every Contract count null when no connector package exists in the workspace', () => {
    repo = writeFixtureRepo();
    const model = analyze(repo);
    for (const node of walkTree(model.tree)) {
      expect(node.counts.Contract).toBeNull();
    }
  });

  it('leaves every L3 count null when the workspace has no second backend service', () => {
    repo = writeFixtureRepo();
    const model = analyze(repo);
    expect(model.availableLevels.L3).toBe(false);
    for (const node of walkTree(model.tree)) {
      expect(node.counts.L3).toBeNull();
    }
  });

  it('reports no commit URL and an "unknown" commit for a repo with no .git directory', () => {
    repo = writeFixtureRepo();
    const model = analyze(repo);
    expect(model.commit).toBe('unknown');
    expect(model.commitUrl).toBeNull();
  });
});
