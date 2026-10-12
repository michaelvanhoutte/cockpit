//
// A Vitest reporter that records each run on the branch's session record
// (scripts/lib/test-run-record.mjs). Every package's Vitest configuration lists
// it, `reporters: ['default', sessionRunReporter]`, so a run is recorded however
// it was started - a package script, one file, the workspace run, a watcher's
// rerun.
//
// A run's scope is its package, or the file where one file ran out of several.
// It never fails the run.
//

import { readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateSessionRecord, recordTestRun, vitestScope } from './test-run-record.mjs';

/** This module's own path, which is how a config names the reporter. */
export const sessionRunReporter = fileURLToPath(import.meta.url);

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
    try {
      const root = this.vitest.config.root;
      const where = locateSessionRecord(root);
      if (!where) return;
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
}
