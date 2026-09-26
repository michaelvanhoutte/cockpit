//
// A Vitest reporter that writes what scripts/lib/test-record.mjs needs from one
// package's run: every test file Vitest knows of, how each one it ran ended,
// and - where COCKPIT_TEST_GRAPH is set, for a package run with `--changed` -
// the import edges under each file it ran. The edges are walked the way
// Vitest's own `--changed` walks them (its transformed modules' static and
// dynamic imports, skipping node_modules), so the chain in the record is the
// graph the selection actually used.
//
// Wired by scripts/ci-test.mjs through COCKPIT_TEST_REPORT (where to write) and
// COCKPIT_REPO_ROOT (what paths are relative to); without the first it does
// nothing. It never fails the run: on any error it writes no report, which the
// record shows as "no report".
//

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const isWindows = process.platform === 'win32';

export default class RecordReporter {
  onInit(vitest) {
    this.vitest = vitest;
  }

  async onTestRunEnd(testModules) {
    const out = process.env.COCKPIT_TEST_REPORT;
    if (!out || !this.vitest) return;
    try {
      const root = process.env.COCKPIT_REPO_ROOT ?? this.vitest.config.root;
      const rel = (path) => relative(root, path).split(sep).join('/');

      const specs = await this.vitest.globTestSpecifications();
      const all = [...new Set(specs.map((spec) => rel(spec.moduleId)))];
      const ran = testModules.map((module) => ({ file: rel(module.moduleId), state: module.state() }));

      const edges = {};
      if (process.env.COCKPIT_TEST_GRAPH) {
        for (const module of testModules) await walk(module.project, module.moduleId, edges, rel);
      }

      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ all, ran, edges }));
    } catch (error) {
      console.warn(`Test record reporter: no report written (${error.message}).`);
    }
  }
}

/** Adds `file -> its imports` for `file` and everything it reaches, once each. */
async function walk(project, file, edges, rel) {
  const key = rel(file);
  if (key in edges) return;
  edges[key] = [];
  const transformed =
    project.vite.environments.ssr.moduleGraph.getModuleById(file)?.transformResult ?? (await project.vite.environments.ssr.transformRequest(file));
  if (!transformed) return;
  for (const dep of [...(transformed.deps ?? []), ...(transformed.dynamicDeps ?? [])]) {
    const fsPath = dep.startsWith('/@fs/') ? dep.slice(isWindows ? 5 : 4) : join(project.config.root, dep);
    if (fsPath.includes('node_modules') || !existsSync(fsPath)) continue;
    edges[key].push(rel(fsPath));
    await walk(project, fsPath, edges, rel);
  }
}
