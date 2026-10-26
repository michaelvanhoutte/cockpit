import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { workspacePackages } from '../../src/workspace.js';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout holding `packages` as folder -> name, and the workspace file `yaml`. */
function checkout(yaml, packages) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-stability-workspace-'));
  made.push(root);
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), yaml);
  for (const [dir, name] of Object.entries(packages)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    if (name !== null) writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name }));
  }
  return root;
}

describe('CI stability', () => {
  describe("a test read from a log is filed under its package's folder, found from the workspace's own package list", () => {
    it('lists the packages of every folder pnpm-workspace.yaml names, a folder with a wildcard and one without', () => {
      const root = checkout("packages:\n  - apps/*\n  - 'tools/*'\n  - packages/shared\n\nonlyBuiltDependencies:\n  - esbuild\n", {
        'apps/web': '@cockpit/web',
        'apps/api': '@cockpit/api',
        'apps/empty': null,
        'tools/architecture': '@cockpit/architecture',
        'packages/shared': '@cockpit/shared',
        'packages/other': '@cockpit/other',
      });

      expect(workspacePackages(root).toSorted((a, b) => a.dir.localeCompare(b.dir))).toEqual([
        { name: '@cockpit/api', dir: 'apps/api' },
        { name: '@cockpit/web', dir: 'apps/web' },
        { name: '@cockpit/shared', dir: 'packages/shared' },
        { name: '@cockpit/architecture', dir: 'tools/architecture' },
      ]);
    });

    it('keeps reading the list past a blank line or a comment between its entries', () => {
      const root = checkout('packages:\n  - apps/* # the apps\n\n  # connectors\n  - packages/shared\n\nonlyBuiltDependencies:\n  - esbuild\n', {
        'apps/web': '@cockpit/web',
        'packages/shared': '@cockpit/shared',
        'tools/other': '@cockpit/other',
      });

      expect(workspacePackages(root).map((each) => each.dir).toSorted()).toEqual(['apps/web', 'packages/shared']);
    });

    it('lists nothing where there is no workspace file or it lists no folder', () => {
      expect(workspacePackages(checkout('onlyBuiltDependencies:\n  - esbuild\n', {}))).toEqual([]);
      expect(workspacePackages(path.join(tmpdir(), 'ci-stability-no-such-checkout'))).toEqual([]);
    });

    it("this repository's own packages are found, including one whose name is not its folder's", () => {
      const packages = workspacePackages();

      expect(packages).toEqual(expect.arrayContaining([
        { name: '@cockpit/web', dir: 'apps/web' },
        { name: '@harness-monitor/worker', dir: 'apps/harness-monitor' },
        { name: '@cockpit/ci-stability', dir: 'tools/ci-stability' },
        { name: '@cockpit/connector-teams', dir: 'packages/connectors/teams' },
      ]));
    });
  });
});
