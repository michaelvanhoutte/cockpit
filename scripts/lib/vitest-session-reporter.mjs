//
// A Vitest reporter that records each run on the branch's session record
// (scripts/lib/test-run-record.mjs). Every package's Vitest configuration lists
// it, `reporters: ['default', sessionRunReporter]`, so a run is recorded however
// it was started - a package script, one file, the workspace run, a watcher's
// rerun.
//
// A run's scope is its package, or the file where one file ran out of several.
// Where COCKPIT_FAILED_TESTS_DIR is set (CI's workflows that run `pnpm test`
// rather than scripts/ci-test.mjs) it also leaves the run's failed tests there.
// It never fails the run.
//

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { vitestFailedTests } from './failed-tests.mjs';
import { locateSessionRecord, recordTestRun, vitestScope } from './test-run-record.mjs';

/** This module's own path, which is how a config names the reporter. */
export const sessionRunReporter = fileURLToPath(import.meta.url);

/** The repository root: where a failed test's file is relative to. */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default class SessionRunReporter {
  onInit(vitest) {
    this.vitest = vitest;
    this.start = Date.now();
  }

  onTestRunStart() {
    this.start = Date.now();
  }

  async onTestRunEnd(testModules) {
    const end = Date.now();
    this.recordFailedTests(testModules);
    try {
      const root = this.vitest.config.root;
      const where = locateSessionRecord(root);
      // Nothing to glob for where there is no record to write to.
      if (!where || !existsSync(where.file)) return;
      const rel = (path) => relative(where.root, path).split(sep).join('/');
      const specs = await this.vitest.globTestSpecifications();
      let packageName = basename(root);
      try {
        packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name ?? packageName;
      } catch {
        // A directory without a package.json is named by its folder.
      }
      const scope = vitestScope({
        packageName,
        files: testModules.map((module) => rel(module.moduleId)),
        known: [...new Set(specs.map((spec) => rel(spec.moduleId)))],
      });
      recordTestRun({ scopes: [scope], start: this.start, end }, root);
    } catch {
      // The run passes or fails on its tests alone.
    }
  }

  /**
   * Where COCKPIT_FAILED_TESTS_DIR names a folder, a run with failed tests
   * leaves its own file there (failed-tests.mjs), for the workflows that run
   * `pnpm test` and not scripts/ci-test.mjs (deploy staging, promote to
   * production, contract) to gather into the record they upload when it is
   * not empty (scripts/ci-failed-tests.mjs). A passing run leaves nothing.
   */
  recordFailedTests(testModules) {
    const dir = process.env.COCKPIT_FAILED_TESTS_DIR;
    if (!dir) return;
    try {
      const rel = (path) => relative(repoRoot, path).split(sep).join('/');
      const failed = vitestFailedTests(testModules, rel);
      if (failed.failedTests.length === 0) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${basename(this.vitest.config.root)}-${process.pid}.json`), JSON.stringify(failed));
    } catch {
      // The run passes or fails on its tests alone.
    }
  }
}
