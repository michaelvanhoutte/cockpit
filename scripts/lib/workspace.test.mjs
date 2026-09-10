//
// Unit tests for testablePackages, run by `node --test` from the Scripts CI
// job. Fixture-driven throughout - no real pnpm call and no real filesystem
// read - so the discovery logic is asserted without a workspace to discover.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { testablePackages } from './workspace.mjs';

const ROOT = join('C:', 'repo');
const at = (...parts) => join(ROOT, ...parts);

/** A `pnpm -r list --depth -1 --json` entry, real packages always carry a version. */
function pkg(name, dir, { root = false } = {}) {
  return root ? { name, path: ROOT } : { name, path: at(...dir.split('/')), version: '0.0.0' };
}

/** A manifest map keyed by package path, read by the fixture `readManifest`. */
function manifests(byPath) {
  return (path) => byPath[path] ?? null;
}

describe('testablePackages', () => {
  it('includes a package that declares its own test:coverage script', () => {
    const list = [pkg('@cockpit/shared', 'packages/shared')];
    const read = manifests({ [at('packages', 'shared')]: { scripts: { 'test:coverage': 'vitest run --coverage' } } });
    assert.deepEqual(testablePackages(list, read, ROOT), [{ name: '@cockpit/shared', dir: 'packages/shared' }]);
  });

  it('excludes a package with no test:coverage script, rather than erroring on it', () => {
    const list = [pkg('@cockpit/config', 'packages/config')];
    const read = manifests({ [at('packages', 'config')]: { scripts: { typecheck: 'tsc' } } });
    assert.deepEqual(testablePackages(list, read, ROOT), []);
  });

  it('skips the workspace root, identified by its path rather than by a missing version field, even when the root itself would otherwise qualify', () => {
    // The root's manifest here declares its own "test:coverage" script and a version -
    // both true of a real package - so the only thing that can be excluding
    // it is the path check. A fixture where the root's manifest is absent or
    // script-less would pass with no root-skip logic at all, proving nothing.
    const list = [
      { name: 'cockpit', path: ROOT, version: '9.9.9' },
      { name: '@cockpit/shared', path: at('packages', 'shared'), version: '0.0.0' },
    ];
    const read = manifests({
      [ROOT]: { scripts: { 'test:coverage': 'vitest run --coverage' } },
      [at('packages', 'shared')]: { scripts: { 'test:coverage': 'vitest run --coverage' } },
    });
    assert.deepEqual(
      testablePackages(list, read, ROOT).map((p) => p.name),
      ['@cockpit/shared'],
    );
  });

  it('still includes a real package missing a version field, rather than mistaking it for the root', () => {
    // `version` is optional in a real package.json, so a package missing one
    // is still a package - identity has to come from `pkg.path`, the one
    // thing that actually means "root", not from a field the root merely
    // happens to lack today.
    const list = [{ name: '@cockpit/shared', path: at('packages', 'shared') }];
    const read = manifests({ [at('packages', 'shared')]: { scripts: { 'test:coverage': 'vitest run --coverage' } } });
    assert.deepEqual(
      testablePackages(list, read, ROOT).map((p) => p.name),
      ['@cockpit/shared'],
    );
  });

  it('finds every real package with a test:coverage script, not only the ones a hand-written list would have named', () => {
    // The bug this module exists to fix: a literal array of shared/api/web
    // silently dropped tools/ci-stability and tools/test-explorer, which
    // carry real suites. This fixture is that exact shape.
    const list = [
      pkg('@cockpit/shared', 'packages/shared'),
      pkg('@cockpit/config', 'packages/config'),
      pkg('@cockpit/api', 'apps/api'),
      pkg('@cockpit/web', 'apps/web'),
      pkg('@cockpit/ci-stability', 'tools/ci-stability'),
      pkg('@cockpit/test-explorer', 'tools/test-explorer'),
    ];
    const withTestCoverage = { scripts: { 'test:coverage': 'vitest run --coverage' } };
    const read = manifests({
      [at('packages', 'shared')]: withTestCoverage,
      [at('packages', 'config')]: { scripts: { typecheck: 'tsc' } },
      [at('apps', 'api')]: withTestCoverage,
      [at('apps', 'web')]: withTestCoverage,
      [at('tools', 'ci-stability')]: withTestCoverage,
      [at('tools', 'test-explorer')]: withTestCoverage,
    });
    assert.deepEqual(
      testablePackages(list, read, ROOT).map((p) => p.name).sort(),
      ['@cockpit/api', '@cockpit/ci-stability', '@cockpit/shared', '@cockpit/test-explorer', '@cockpit/web'].sort(),
    );
  });

  it('gives dir in POSIX form relative to root, matching what git diff --name-only reports', () => {
    const list = [pkg('@cockpit/api', 'apps/api')];
    const read = manifests({ [at('apps', 'api')]: { scripts: { 'test:coverage': 'vitest run --coverage' } } });
    assert.equal(testablePackages(list, read, ROOT)[0].dir, 'apps/api');
  });

  it('is an empty list for an empty workspace, rather than throwing', () => {
    assert.deepEqual(testablePackages([], manifests({}), ROOT), []);
  });

  it('treats a missing manifest the same as one with no test:coverage script', () => {
    const list = [pkg('@cockpit/orphan', 'packages/orphan')];
    assert.deepEqual(testablePackages(list, manifests({}), ROOT), []);
  });
});
