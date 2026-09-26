//
// Unit tests for planE2eRun, run by `node --test` from the Scripts step. Each
// case is a row of the statement list from "Run only the affected specs in
// CI's E2E (F3) job on a pull request" (issue 347). Playwright's own `--grep`
// matching is its own tested behaviour and is not re-proved here.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { grepFor, planE2eRun } from './e2e-selection.mjs';

const MERGE_BASE = 'a1b2c3d';

const PACKAGES = [
  { name: '@cockpit/shared', dir: 'packages/shared' },
  { name: '@cockpit/api', dir: 'apps/api' },
  { name: '@cockpit/web', dir: 'apps/web' },
];

const CONCEPTS = [
  { key: 'Capture', sourcePatterns: ['apps/api/src/domain/items.ts', 'apps/web/src/capture/**'] },
  { key: 'Triage', sourcePatterns: ['apps/api/src/domain/items.ts'] },
  { key: 'Sign-in', sourcePatterns: ['apps/web/src/pages/LogonPage.tsx'] },
  { key: 'Ahead of its code', sourcePatterns: [] },
];

const WALKS = [
  { area: 'Capture', where: 'capture.test.ts' },
  { area: 'Triage', where: 'triage.test.ts' },
  { area: 'Sign-in', where: 'sign-in.test.ts' },
];

function plan(changedFiles, overrides = {}) {
  return planE2eRun({ event: 'pull_request', mergeBase: MERGE_BASE, changedFiles, concepts: CONCEPTS, walks: WALKS, packages: PACKAGES, ...overrides });
}

describe('planE2eRun', () => {
  it('requires the registry, the listing and the package list rather than guessing', () => {
    assert.throws(() => planE2eRun({ event: 'pull_request', mergeBase: MERGE_BASE, changedFiles: [] }), /needs the registry/);
  });

  describe('a pull request', () => {
    it('runs only the area that owns a file listed under one area', () => {
      const result = plan(['apps/web/src/capture/Box.tsx']);
      assert.deepEqual(result, { mode: 'selected', areas: ['Capture'], grep: grepFor(['Capture']) });
    });

    it('runs every area that owns a file listed under several', () => {
      const result = plan(['apps/api/src/domain/items.ts']);
      assert.deepEqual(result.areas, ['Capture', 'Triage']);
    });

    it('runs the union of the areas of every changed file', () => {
      const result = plan(['apps/web/src/capture/Box.tsx', 'apps/web/src/pages/LogonPage.tsx']);
      assert.deepEqual(result.areas, ['Capture', 'Sign-in']);
    });

    it('runs every walk for a file no area owns', () => {
      assert.equal(plan(['apps/web/src/api/client.ts', 'apps/web/src/capture/Box.tsx']).mode, 'full');
    });

    it('runs nothing for areas that own no walk yet', () => {
      const result = plan(['apps/web/src/capture/Box.tsx'], { walks: [] });
      assert.deepEqual(result, { mode: 'selected', areas: [], grep: null });
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
