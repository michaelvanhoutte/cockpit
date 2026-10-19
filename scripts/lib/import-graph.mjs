//
// Who imports a file ("Build the import graph of the workspace's sources",
// issue 1281, the first half of "Make the E2E (F3) selection fire: place a
// changed file by what imports it", issue 1275): a static read of every import
// statement across the workspace's source files, so a changed file can be
// placed by the files that import it, followed as far as needed.
//
// An import is an edge however it is written - default, named, side-effect,
// export-from, dynamic with a literal, and `import type`, counted on purpose
// since over-selecting is the safe side. A specifier resolves as the toolchain
// does: an omitted extension tries .ts, .tsx, .mts, .js, .jsx, .mjs in that
// order, a directory its index file, a `.js` specifier the .ts or .tsx source
// beside it (a `.d.ts` is not a source), a workspace package name the entry
// its package.json declares, and a stylesheet, JSON or image the file itself. A
// bare third-party name gives no edge. A specifier naming no file gives no
// edge and is named among `unresolved`; a computed dynamic import gives no edge
// and its file is named among `computedImports`, so a misconfiguration is
// visible rather than a silent miss. tsconfig `paths` are not read: no
// tsconfig in the workspace declares any.
//
// Pure: no git, no filesystem, no process. The graph is a function of a map of
// repo-relative POSIX paths to their text and the `{ name, dir }` package list
// (the shape scripts/lib/workspace.mjs gives), so every rule is asserted
// without a checkout. A package's manifest is its `<dir>/package.json` in that
// same map. `readImportGraph` is the one that walks the tree, for
// scripts/ci-e2e.mjs.
//

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

import { importsOf } from './import-rules.mjs';

/** The toolchain's order for an omitted extension. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
/** The source an emitted extension stands for: `./a.js` is written, `a.ts` is on disk. */
const SOURCE_OF = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'] };
const DECLARATION = /\.d\.[cm]?ts$/;
const isSource = (path) => EXTENSIONS.includes(posix.extname(path)) && !DECLARATION.test(path);

/**
 * @typedef {{ name: string, dir: string }} Pkg
 * @typedef {{ importer: string, specifier: string }} Unresolved
 * @typedef {{
 *   filesRead: number,
 *   unresolved: Unresolved[],
 *   computedImports: { file: string, line: number }[],
 *   importersOf: (path: string) => string[],
 *   transitiveImportersOf: (path: string) => string[],
 * }} ImportGraph
 */

/**
 * The graph over `files`.
 *
 * - `filesRead`: how many source files were parsed.
 * - `unresolved`: every `{ importer, specifier }` that names no file.
 * - `computedImports`: every file with a dynamic import that names no specifier.
 * - `importersOf(path)`: the files that import `path` directly.
 * - `transitiveImportersOf(path)`: the files that import it directly or through
 *   other files. A cycle ends; a file in one is not its own importer.
 *
 * Both importer lists are sorted, and empty for a file nothing imports or one
 * the map does not hold.
 * @param {Map<string, string> | Record<string, string>} files repo-relative POSIX path to text; a file that is not a source (an asset) only has to be present
 * @param {Pkg[]} packages every workspace package, not only those with tests
 * @returns {ImportGraph}
 */
export function buildImportGraph(files, packages) {
  const map = files instanceof Map ? files : new Map(Object.entries(files));
  const has = (path) => map.has(path) && !DECLARATION.test(path);
  const byName = [...packages].sort((a, b) => b.name.length - a.name.length);

  const resolveFile = (target) => {
    const base = target.replace(/\/+$/, '');
    if (has(base)) return base;
    const ext = posix.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const candidates = [
      ...(SOURCE_OF[ext] ?? []).map((replacement) => stem + replacement),
      ...EXTENSIONS.map((e) => base + e),
      ...EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
    return candidates.find(has) ?? null;
  };

  const manifestOf = (pkg) => {
    try {
      return JSON.parse(map.get(posix.join(pkg.dir, 'package.json')) ?? '');
    } catch {
      return null;
    }
  };

  /** The file a workspace package's `subpath` (`.` or `./x`) names through its manifest. */
  const resolvePackage = (pkg, subpath) => {
    const manifest = manifestOf(pkg);
    const targets = manifest ? targetsFor(manifest, subpath) : [];
    for (const target of targets) {
      const found = resolveFile(posix.normalize(posix.join(pkg.dir, target)));
      if (found) return found;
    }
    if (manifest?.exports !== undefined && manifest.exports !== null) return null;
    // No `exports` to encapsulate the package: the folder itself, as Node reads it.
    return resolveFile(posix.normalize(posix.join(pkg.dir, subpath === '.' ? '' : subpath)));
  };

  const resolve = (importer, specifier) => {
    const bare = specifier.replace(/[?#].*$/, '');
    if (bare === '.' || bare === '..' || bare.startsWith('./') || bare.startsWith('../')) {
      return resolveFile(posix.normalize(posix.join(posix.dirname(importer), bare)));
    }
    if (bare.startsWith('/')) return null;
    const pkg = byName.find(({ name }) => bare === name || bare.startsWith(`${name}/`));
    if (pkg) return resolvePackage(pkg, bare === pkg.name ? '.' : `.${bare.slice(pkg.name.length)}`);
    return undefined; // third party or built in: no edge, and nothing to report
  };

  const importers = new Map();
  const unresolved = [];
  const computedImports = [];
  let filesRead = 0;
  for (const [path, text] of map) {
    if (!isSource(path)) continue;
    filesRead += 1;
    const { specifiers, computed } = importsOf(path, text);
    for (const line of computed) computedImports.push({ file: path, line });
    for (const { specifier } of specifiers) {
      const target = resolve(path, specifier);
      if (target === undefined) continue;
      if (target === null) unresolved.push({ importer: path, specifier });
      else if (importers.has(target)) importers.get(target).add(path);
      else importers.set(target, new Set([path]));
    }
  }

  const importersOf = (path) => [...(importers.get(path) ?? [])].sort();
  const transitiveImportersOf = (path) => {
    const seen = new Set([path]);
    const queue = [path];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const importer of importers.get(next) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        queue.push(importer);
      }
    }
    seen.delete(path);
    return [...seen].sort();
  };

  const byImporter = (a, b) => a.importer.localeCompare(b.importer) || a.specifier.localeCompare(b.specifier);
  return {
    filesRead,
    unresolved: unresolved.sort(byImporter),
    computedImports: computedImports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    importersOf,
    transitiveImportersOf,
  };
}

/**
 * The files a manifest names for `subpath` (`.` or `./x`), most specific first:
 * the `exports` entry, then for the package itself `module`, `main`, `types`.
 * @param {Record<string, any>} manifest
 * @param {string} subpath
 * @returns {string[]}
 */
function targetsFor(manifest, subpath) {
  const { exports } = manifest;
  if (exports !== undefined && exports !== null) {
    const subpaths = typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'));
    const map = subpaths ? exports : { '.': exports };
    if (subpath in map) return flatten(map[subpath]);
    for (const [pattern, value] of Object.entries(map)) {
      const star = pattern.indexOf('*');
      if (star < 0) continue;
      const head = pattern.slice(0, star);
      const tail = pattern.slice(star + 1);
      if (subpath.length >= head.length + tail.length && subpath.startsWith(head) && subpath.endsWith(tail)) {
        const matched = subpath.slice(head.length, subpath.length - tail.length);
        return flatten(value).map((target) => target.replace(/\*/g, matched));
      }
    }
    return [];
  }
  if (subpath !== '.') return [];
  return [manifest.module, manifest.main, manifest.types, manifest.typings].filter((field) => typeof field === 'string');
}

/** Every string target in an `exports` value, whatever conditions or fallbacks nest it. */
function flatten(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flatten);
  return [];
}

/** Folders the walk never enters: dependencies, build output, and `poc/`, which is outside the workspace. */
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', 'poc']);

/**
 * Every file under `root` as the map `buildImportGraph` takes: the text of each
 * source file and of each package.json, an empty string for any other file
 * (an asset only has to exist). Dot folders and `SKIPPED` are not entered.
 * @param {string} root absolute
 * @returns {Map<string, string>}
 */
export function readTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const full = join(dir, entry.name);
        const path = relative(root, full).split(sep).join('/');
        files.set(path, isSource(path) || entry.name === 'package.json' ? readFileSync(full, 'utf8') : '');
      }
    }
  };
  walk(root);
  return files;
}

/**
 * The package list `buildImportGraph` takes, from parsed `pnpm -r list --json`
 * output (`pnpmWorkspaceList` in scripts/lib/processes.mjs), every package but
 * the workspace root.
 * @param {{ name: string, path: string }[]} pnpmList
 * @param {string} root absolute
 * @returns {Pkg[]}
 */
export function packagesOf(pnpmList, root) {
  return pnpmList
    .filter((pkg) => relative(root, pkg.path) !== '')
    .map((pkg) => ({ name: pkg.name, dir: relative(root, pkg.path).split(sep).join('/') }));
}

/**
 * The graph over the tree under `root`.
 * @param {string} root absolute
 * @param {Pkg[]} packages
 */
export const readImportGraph = (root, packages) => buildImportGraph(readTree(root), packages);
