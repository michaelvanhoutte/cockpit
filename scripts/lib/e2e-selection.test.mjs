//
// Unit tests for planE2eRun, run by `node --test` from the Scripts step. The
// first cases are rows of the statement list from "Run only the affected specs
// in CI's E2E (F3) job on a pull request" (issue 347); the placement cases are
// rows of "Place a changed file by its importers in the E2E (F3) selection"
// (issue 1282). Playwright's own `--grep` matching is its own tested behaviour
// and is not re-proved here.
//
// The graph is a hand-written map of who imports what: the real one needs a
// compiler package this step runs without, so it is tested under tests/lint/.
//

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { grepFor, planE2eRun, ROOTS, STACK_INPUTS } from './e2e-selection.mjs';

const MERGE_BASE = 'a1b2c3d';

const CONCEPTS = [
  { key: 'Capture', sourcePatterns: ['apps/api/src/domain/items.ts', 'apps/web/src/capture/**'] },
  { key: 'Triage', sourcePatterns: ['apps/api/src/domain/items.ts'] },
  { key: 'Sign-in', sourcePatterns: ['apps/web/src/pages/LogonPage.tsx'] },
  { key: 'MCP connections', sourcePatterns: ['apps/api/src/mcp/server.ts'] },
  { key: 'Panels', sourcePatterns: ['apps/web/src/panels/PanelA.tsx'] },
  { key: 'Dashboards', sourcePatterns: ['apps/web/src/panels/PanelB.tsx'] },
  { key: 'Ahead of its code', sourcePatterns: [] },
];

const WALKS = [
  { area: 'Capture', where: 'capture.test.ts' },
  { area: 'Triage', where: 'triage.test.ts' },
  { area: 'Sign-in', where: 'sign-in.test.ts' },
  { area: 'MCP connections', where: 'connections.test.ts' },
  { area: 'Panels', where: 'panels.test.ts' },
  { area: 'Dashboards', where: 'dashboards.test.ts' },
];

/** Who imports whom, importer to the files it imports. */
const IMPORTS = {
  'apps/api/src/mcp/server.ts': ['apps/api/src/mcp/newTool.ts', 'apps/api/src/mcp/relay.ts'],
  'apps/api/src/mcp/relay.ts': ['apps/api/src/mcp/deepHelper.ts'],
  'apps/web/src/panels/PanelA.tsx': ['apps/web/src/ui/Chip.tsx'],
  'apps/web/src/panels/PanelB.tsx': ['apps/web/src/ui/Chip.tsx'],
  'apps/web/src/capture/Box.tsx': ['apps/web/src/panels/PanelA.tsx'],
  'apps/web/src/main.tsx': ['apps/web/src/lib/format.ts', 'apps/web/src/ui/Tied.tsx'],
  'apps/web/src/capture/Tie.tsx': ['apps/web/src/ui/Tied.tsx'],
  'scripts/ci-e2e.mjs': ['scripts/lib/helper.mjs'],
  'apps/web/vite.config.ts': ['apps/web/manifest.ts'],
};

/** The slice of the import graph planE2eRun reads. */
function graphOf(imports) {
  const importers = new Map();
  for (const [importer, files] of Object.entries(imports)) {
    for (const file of files) importers.set(file, [...(importers.get(file) ?? []), importer].sort());
  }
  return { importersOf: (path) => importers.get(path) ?? [] };
}

function plan(changedFiles, overrides = {}) {
  return planE2eRun({ event: 'pull_request', mergeBase: MERGE_BASE, changedFiles, concepts: CONCEPTS, walks: WALKS, graph: graphOf(IMPORTS), ...overrides });
}

describe('planE2eRun', () => {
  it('requires the registry, the listing and the import graph rather than guessing', () => {
    assert.throws(() => planE2eRun({ event: 'pull_request', mergeBase: MERGE_BASE, changedFiles: [] }), /needs the registry/);
  });

  describe('a pull request', () => {
    it('runs only the area that owns a file listed under one area', () => {
      const result = plan(['apps/web/src/capture/Box.tsx']);
      assert.deepEqual(result, { mode: 'selected', areas: ['Capture'], grep: grepFor(['Capture']), changedBy: { Capture: 'apps/web/src/capture/Box.tsx' }, via: {}, unplaced: [] });
    });

    it('names, for each area, the first changed file it owns', () => {
      const result = plan(['apps/api/src/domain/items.ts', 'apps/web/src/capture/Box.tsx']);
      assert.deepEqual(result.changedBy, { Capture: 'apps/api/src/domain/items.ts', Triage: 'apps/api/src/domain/items.ts' });
    });

    it('names a changed spec file as what selected the areas it is written under', () => {
      assert.deepEqual(plan(['tests/e2e/triage.test.ts']).changedBy, { Triage: 'tests/e2e/triage.test.ts' });
    });

    it('runs every area that owns a file listed under several', () => {
      const result = plan(['apps/api/src/domain/items.ts']);
      assert.deepEqual(result.areas, ['Capture', 'Triage']);
    });

    it('runs the union of the areas of every changed file', () => {
      const result = plan(['apps/web/src/capture/Box.tsx', 'apps/web/src/pages/LogonPage.tsx']);
      assert.deepEqual(result.areas, ['Capture', 'Sign-in']);
    });

    it('runs nothing for areas that own no walk yet', () => {
      const result = plan(['apps/web/src/capture/Box.tsx'], { walks: [] });
      assert.deepEqual(result, { mode: 'selected', areas: [], grep: null, changedBy: {}, via: {}, unplaced: [] });
    });

    it('runs the areas a changed spec file is written under', () => {
      const result = plan(['tests/e2e/triage.test.ts']);
      assert.deepEqual(result.areas, ['Triage']);
    });

    it('runs every walk for a spec file the listing cannot place', () => {
      assert.equal(plan(['tests/e2e/deleted.test.ts']).mode, 'full');
      assert.equal(plan(['tests/e2e/fixtures/data.json']).mode, 'full');
    });

    it('runs every walk for a spec file holding a walk under no area', () => {
      const walks = [...WALKS, { area: null, where: 'loose.test.ts' }];
      assert.equal(plan(['tests/e2e/loose.test.ts'], { walks }).mode, 'full');
    });

    it('ignores a documentation-only path beside a product change', () => {
      const result = plan(['docs/architecture.md', 'apps/web/src/capture/Box.tsx']);
      assert.deepEqual(result.areas, ['Capture']);
    });
  });

  describe('a file the registry cannot place takes the areas of its nearest registered importers', () => {
    it('a new MCP file imported by the MCP server runs MCP connections’ walks only', () => {
      const result = plan(['apps/api/src/mcp/newTool.ts']);
      assert.deepEqual(result.areas, ['MCP connections']);
      assert.deepEqual(result.via, { 'MCP connections': 'apps/api/src/mcp/server.ts' });
      assert.deepEqual(result.changedBy, { 'MCP connections': 'apps/api/src/mcp/newTool.ts' });
    });

    it('a new component imported by two registered components in different areas runs the union', () => {
      const result = plan(['apps/web/src/ui/Chip.tsx']);
      assert.deepEqual(result.areas, ['Dashboards', 'Panels']);
      assert.deepEqual(result.via, { Panels: 'apps/web/src/panels/PanelA.tsx', Dashboards: 'apps/web/src/panels/PanelB.tsx' });
    });

    it('a registered file two hops up gives that file’s areas', () => {
      const result = plan(['apps/api/src/mcp/deepHelper.ts']);
      assert.deepEqual(result.areas, ['MCP connections']);
      assert.deepEqual(result.via, { 'MCP connections': 'apps/api/src/mcp/server.ts' });
    });

    it('a registered file is placed by the registry alone, whatever imports it', () => {
      // Box.tsx, owned by Capture, imports PanelA.tsx: PanelA keeps only Panels.
      const result = plan(['apps/web/src/panels/PanelA.tsx']);
      assert.deepEqual(result.areas, ['Panels']);
      assert.deepEqual(result.via, {});
    });

    it('importers that reach a root with no registered file on the way run every walk, naming the root and the rule', () => {
      const result = plan(['apps/web/src/lib/format.ts']);
      assert.equal(result.mode, 'full');
      assert.deepEqual(result.forced, { rule: 'loaded by the job, owned by no area', path: 'apps/web/src/main.tsx' });
    });

    it('a root and a registered file at the same depth run every walk, since neither is first', () => {
      const result = plan(['apps/web/src/ui/Tied.tsx']);
      assert.equal(result.mode, 'full');
      assert.equal(result.forced.path, 'apps/web/src/main.tsx');
    });

    it('a file nothing imports selects no walk, and the plan names it', () => {
      const result = plan(['apps/api/src/orphan.ts']);
      assert.deepEqual(result, { mode: 'selected', areas: [], grep: null, changedBy: {}, via: {}, unplaced: ['apps/api/src/orphan.ts'] });
    });

    it('a unit test file of another tier selects no walk', () => {
      const result = plan(['apps/api/tests/unit/domain/items.test.ts']);
      assert.deepEqual(result.areas, []);
      assert.equal(result.mode, 'selected');
    });

    it('a README anywhere selects no walk', () => {
      for (const path of ['tools/cycle-time/README.md', 'apps/api/src/mcp/README.md']) {
        const result = plan([path, 'apps/web/src/capture/Box.tsx']);
        assert.deepEqual(result.areas, ['Capture']);
        assert.deepEqual(result.unplaced, [path]);
      }
    });

    it('a tooling script no root reaches selects no walk', () => {
      const result = plan(['scripts/cycle-time.mjs']);
      assert.equal(result.mode, 'selected');
      assert.deepEqual(result.areas, []);
    });

    it('a script the e2e runner imports runs every walk', () => {
      const result = plan(['scripts/lib/helper.mjs']);
      assert.equal(result.mode, 'full');
      assert.deepEqual(result.forced, { rule: 'loaded by the job, owned by no area', path: 'scripts/ci-e2e.mjs' });
    });

    it('a root changed itself runs every walk', () => {
      assert.deepEqual(plan(['scripts/ci-e2e.mjs']).forced, { rule: 'loaded by the job, owned by no area', path: 'scripts/ci-e2e.mjs' });
    });

    it('an unplaceable file beside a placeable one gives the union', () => {
      const result = plan(['apps/api/src/orphan.ts', 'apps/api/src/mcp/newTool.ts']);
      assert.deepEqual(result.areas, ['MCP connections']);
      assert.deepEqual(result.unplaced, ['apps/api/src/orphan.ts']);
    });

    it('full wins where any changed file says so', () => {
      assert.equal(plan(['apps/api/src/mcp/newTool.ts', 'apps/web/src/lib/format.ts']).mode, 'full');
    });

    it('a cycle among unregistered importers ends and selects nothing', () => {
      const graph = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
      assert.deepEqual(plan(['a.ts'], { graph }).unplaced, ['a.ts']);
    });
  });

  describe('the job’s roots and stack inputs', () => {
    it('a stack input changed runs every walk, naming it', () => {
      for (const path of ['apps/api/migrations/0017_new.sql', 'apps/harness-monitor/migrations/0011_new.sql', 'apps/api/seed.sql', 'apps/api/wrangler.jsonc', 'apps/web/vite.config.ts', 'apps/web/index.html', 'apps/web/public/share-target-sw.js', 'apps/web/src/appearanceBoot.js']) {
        assert.deepEqual(plan([path, 'apps/web/src/capture/Box.tsx']).forced, { rule: 'stack input', path }, path);
      }
    });

    it('a file only a stack input imports runs every walk, naming the stack input', () => {
      assert.deepEqual(plan(['apps/web/manifest.ts']).forced, { rule: 'loaded by the job, owned by no area', path: 'apps/web/vite.config.ts' });
    });

    it('a file outside every package that nothing imports selects no walk, where it forced every walk before', () => {
      const result = plan(['tools/cycle-time/src/model.js', 'apps/web/src/capture/Box.tsx']);
      assert.equal(result.mode, 'selected');
      assert.deepEqual(result.areas, ['Capture']);
    });

    const root = fileURLToPath(new URL('../../', import.meta.url));
    for (const [list, entries] of [['root', ROOTS], ['stack input', STACK_INPUTS]]) {
      for (const entry of entries) {
        it(`the ${list} ${entry} exists`, () => {
          const path = `${root}${entry}`;
          assert.ok(existsSync(path), `${entry} is declared as a ${list} and no longer exists: rename it in scripts/lib/e2e-selection.mjs too`);
          assert.equal(statSync(path).isDirectory(), entry.endsWith('/'), `${entry} is ${entry.endsWith('/') ? 'a folder in the list and a file on disk' : 'a file in the list and a folder on disk'}`);
        });
      }
    }
  });

  describe('what forces every walk', () => {
    const forcing = [
      'tests/e2e/support/app.ts',
      'tools/test-explorer/concepts.json',
      'playwright.config.ts',
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      'package.json',
      'pnpm-lock.yaml',
      'apps/web/package.json',
      'tsconfig.base.json',
      'apps/api/tsconfig.json',
      'scripts/e2e-stack.mjs',
    ];
    for (const path of forcing) {
      it(`${path} beside a file with an owner`, () => {
        assert.equal(plan(['apps/web/src/capture/Box.tsx', path]).mode, 'full');
      });
    }

    it('a push to main, whatever the merged diff was', () => {
      assert.equal(plan(['apps/web/src/capture/Box.tsx'], { event: 'push' }).mode, 'full');
    });

    it('a merge-base that could not be placed', () => {
      assert.equal(plan(['apps/web/src/capture/Box.tsx'], { mergeBase: null }).mode, 'full');
    });

    it('a diff with no product file in it', () => {
      assert.equal(plan(['docs/architecture.md']).mode, 'full');
    });
  });

  // The `{ rule, path }` the record keeps (scripts/lib/e2e-record.mjs) and the
  // report's forced-full rows group on.
  describe('the rule that forced every walk', () => {
    it('is "push to main", with no path, for a push', () => {
      assert.deepEqual(plan(['apps/web/src/capture/Box.tsx'], { event: 'push' }).forced, { rule: 'push to main', path: null });
    });

    it('is "diff unreadable", with no path, for a merge-base that could not be placed', () => {
      assert.deepEqual(plan(['apps/web/src/capture/Box.tsx'], { mergeBase: null }).forced, { rule: 'diff unreadable', path: null });
    });

    it('names the rule and the path for support code, a workflow, the lockfile, a package.json or a tsconfig', () => {
      assert.deepEqual(plan(['tests/e2e/support/app.ts']).forced, { rule: 'e2e support, registry or config', path: 'tests/e2e/support/app.ts' });
      assert.deepEqual(plan(['.github/workflows/ci.yml']).forced, { rule: 'workflow or action', path: '.github/workflows/ci.yml' });
      assert.deepEqual(plan(['pnpm-lock.yaml']).forced, { rule: 'lockfile', path: 'pnpm-lock.yaml' });
      assert.deepEqual(plan(['apps/web/package.json']).forced, { rule: 'any package.json', path: 'apps/web/package.json' });
      assert.deepEqual(plan(['apps/api/tsconfig.json']).forced, { rule: 'any tsconfig', path: 'apps/api/tsconfig.json' });
    });

    it('is "spec with no area" for a spec file the listing cannot place', () => {
      assert.deepEqual(plan(['tests/e2e/deleted.test.ts']).forced, { rule: 'spec with no area', path: 'tests/e2e/deleted.test.ts' });
    });
  });
});

describe('grepFor', () => {
  // What Playwright greps is the title path joined with spaces, not the `›` listing.
  it('matches an area as the outer describe that follows the file', () => {
    const grep = new RegExp(grepFor(['Capture', 'Sign-in']));
    assert.ok(grep.test('desktop capture.test.ts Capture a thought lists it'));
    assert.ok(grep.test('phone x.test.ts Sign-in a title'));
    assert.ok(!grep.test('desktop item-editing.test.ts Item editing the form follows the Capture you make'));
    assert.ok(!grep.test('desktop x.test.ts Capture-ish a title'));
  });

  it('escapes a title that holds a regular-expression character', () => {
    const grep = new RegExp(grepFor(['Panels (grid)']));
    assert.ok(grep.test('desktop x.test.ts Panels (grid) a title'));
  });
});

describe('the tests/e2e/ prefix', () => {
  it('shares its constant with test-selection.mjs rather than redefining it', () => {
    // Asserted against the source rather than by behaviour alone, mirroring
    // test-selection.test.mjs's own isNonProduct-sharing test - importing
    // SPECS here and using it inline would pass even if e2e-selection.mjs
    // carried its own separate copy of the same literal.
    const path = fileURLToPath(new URL('./e2e-selection.mjs', import.meta.url));
    const source = readFileSync(path, 'utf8');
    assert.match(source, /import\s*\{[^}]*\bSPECS\b[^}]*\}\s*from\s*'\.\/test-selection\.mjs';/, 'e2e-selection.mjs should import SPECS rather than duplicate it');
    assert.doesNotMatch(source, /const SPECS = /, 'e2e-selection.mjs should not redefine SPECS itself');
  });
});
