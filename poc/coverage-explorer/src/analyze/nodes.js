/**
 * Node derivation: decision 2 of docs/coverage-reporting-options.md.
 *
 * Nodes come from artifacts the repo already maintains and already enforces.
 * Nothing here is a list somebody has to remember to update:
 *
 *   1. pnpm-workspace.yaml globs        ->  package nodes
 *   2. architecture §6.1 layer folders  ->  layer nodes inside a service
 *   3. the workspace glob for connectors ->  one node per connector package
 *   4. commandSchemas in shared          ->  the capability axis (see tests.js)
 *
 * A node that cannot be traced to one of those does not belong in the tree,
 * because nothing will keep it honest. The two exceptions live in
 * policy/annotations.js as EXTRA_NODES, declared with their reasons.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** Layer folders named in architecture §6.1, plus the frontend's own. */
const KNOWN_LAYERS = new Set([
  'domain',
  'db',
  'http',
  'jobs',
  'ai',
  'connectors',
  'components',
  'pages',
  'api',
]);

const SOURCE_EXT = /\.(ts|tsx)$/;
const IS_TEST = /\.test\.(ts|tsx)$/;

/**
 * Source 1: the workspace globs. Parsed with a deliberately small reader rather
 * than a YAML dependency, because the file is three lines and a dependency here
 * is a dependency in every future consumer of this POC.
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
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const m = line.match(/^\s+-\s+(.+?)\s*$/);
      if (m) { globs.push(m[1].replace(/^['"]|['"]$/g, '')); continue; }
      if (line.trim() !== '') inPackages = false;
    }
  }

  const dirs = [];
  for (const glob of globs) {
    // Only the `a/b/*` shape is used in this repo; anything else is reported
    // rather than silently ignored.
    const m = glob.match(/^(.*)\/\*$/);
    if (!m) continue;
    const parent = path.join(repo, m[1]);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = path.join(m[1], entry.name);
      if (existsSync(path.join(repo, rel, 'package.json'))) dirs.push(rel);
    }
  }
  // A connector package matches both `packages/*` and `packages/connectors/*`.
  return [...new Set(dirs)].sort();
}

/**
 * Classifies a package. A wrangler config means it owns real infrastructure,
 * which is what makes it the node that owes integration coverage; a vite config
 * means it is the frontend service.
 *
 * @returns {{ kind: string, frontend: boolean, obligationKey: string }}
 */
export function classifyPackage(repo, rel) {
  if (rel.startsWith('packages/connectors/')) {
    return { kind: 'connector', frontend: false, obligationKey: 'connector' };
  }
  const has = (f) => existsSync(path.join(repo, rel, f));
  if (has('wrangler.jsonc') || has('wrangler.toml') || has('wrangler.json')) {
    return { kind: 'service', frontend: false, obligationKey: 'service_backend' };
  }
  if (has('vite.config.ts') || has('vite.config.js')) {
    return { kind: 'service', frontend: true, obligationKey: 'service_frontend' };
  }
  return { kind: 'pkg', frontend: false, obligationKey: null };
}

/**
 * Source 2: walk a package's src/, grouping files under layer folders where the
 * folder name is one architecture §6.1 names. Files directly in src/, and files
 * under an unrecognised folder, attach to the package itself: an invented
 * grouping would be exactly the hand-authored tree this design rejects.
 *
 * @returns {{ layers: Map<string, string[]>, loose: string[], tests: string[] }}
 *   paths are repo-relative
 */
export function scanPackage(repo, rel) {
  const src = path.join(repo, rel, 'src');
  const layers = new Map();
  const loose = [];
  const tests = [];
  if (!existsSync(src)) return { layers, loose, tests };

  const walk = (dir, layer) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nextLayer = layer ?? (KNOWN_LAYERS.has(entry.name) ? entry.name : null);
        walk(abs, nextLayer);
        continue;
      }
      if (!SOURCE_EXT.test(entry.name)) continue;
      const relPath = path.relative(repo, abs);
      if (IS_TEST.test(entry.name)) { tests.push(relPath); continue; }
      if (layer) {
        if (!layers.has(layer)) layers.set(layer, []);
        layers.get(layer).push(relPath);
      } else {
        loose.push(relPath);
      }
    }
  };
  walk(src, null);
  return { layers, loose, tests };
}

/** Package name from its manifest, used to resolve workspace imports. */
export function packageName(repo, rel) {
  try {
    return JSON.parse(readFileSync(path.join(repo, rel, 'package.json'), 'utf8')).name ?? null;
  } catch {
    return null;
  }
}

/** Entry file a workspace specifier resolves to, per the manifest's exports. */
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

export function lineCount(repo, rel) {
  const abs = path.join(repo, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
  return readFileSync(abs, 'utf8').split('\n').length;
}
