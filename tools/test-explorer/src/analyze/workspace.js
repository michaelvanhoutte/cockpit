/**
 * Reading pnpm-workspace.yaml and package manifests. Ported from
 * poc/coverage-explorer/src/analyze/nodes.js's workspacePackages/packageName/
 * packageEntry — layer classification and package "kind" are dropped, since
 * this tool's rows are feature areas (concepts.js), not the structural tree
 * the POC rendered.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * A deliberately small reader rather than a YAML dependency: the file is a
 * handful of lines and a dependency here is a dependency in every consumer.
 *
 * @param {string} repo absolute repo root
 * @returns {string[]} repo-relative package directories
 */
export function workspacePackages(repo) {
  const file = path.join(repo, 'pnpm-workspace.yaml');
  const text = readFileSync(file, 'utf8');
  const globs = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s+-\s+(.+?)\s*$/);
      if (m) {
        globs.push(m[1].replace(/^['"]|['"]$/g, ''));
        continue;
      }
      if (line.trim() !== '') inPackages = false;
    }
  }

  const dirs = [];
  for (const glob of globs) {
    const m = glob.match(/^(.*)\/\*$/);
    if (!m) continue;
    const parent = path.join(repo, m[1]);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = path.join(m[1], entry.name).split(path.sep).join('/');
      if (existsSync(path.join(repo, rel, 'package.json'))) dirs.push(rel);
    }
  }
  return [...new Set(dirs)].sort();
}

/** Package name from its manifest, used to resolve workspace-specifier imports. */
export function packageName(repo, rel) {
  try {
    return JSON.parse(readFileSync(path.join(repo, rel, 'package.json'), 'utf8')).name ?? null;
  } catch {
    return null;
  }
}

/** Entry file a workspace specifier resolves to, per the manifest's exports map. */
export function packageEntry(repo, rel) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(repo, rel, 'package.json'), 'utf8'));
    const entry = typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : null;
    if (!entry) return null;
    const abs = path.resolve(repo, rel, entry);
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

/** Every .ts/.tsx file under a package's src/, repo-relative. */
export function sourceFiles(repo, rel) {
  const src = path.join(repo, rel, 'src');
  const out = [];
  if (!existsSync(src)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.d\.ts$/.test(entry.name)) continue;
      out.push(path.relative(repo, abs).split(path.sep).join('/'));
    }
  };
  walk(src);
  return out;
}

/** Every .test.ts/.test.tsx file under a package's tests/, repo-relative, plus its level folder. */
export function testFiles(repo, rel) {
  const testsDir = path.join(repo, rel, 'tests');
  const out = [];
  if (!existsSync(testsDir)) return out;
  for (const level of readdirSync(testsDir, { withFileTypes: true })) {
    if (!level.isDirectory()) continue;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!/\.test\.(ts|tsx)$/.test(entry.name)) continue;
        out.push({ level: level.name, file: path.relative(repo, abs).split(path.sep).join('/') });
      }
    };
    walk(path.join(testsDir, level.name));
  }
  return out;
}
