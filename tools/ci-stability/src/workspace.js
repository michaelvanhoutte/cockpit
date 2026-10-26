/**
 * The workspace's packages, read from the checkout the command runs in: `pnpm-workspace.yaml`
 * lists the folders (`apps/*`, `tools/*`), each folder's `package.json` names its package. A log
 * of CI names a Vitest file relative to its package, behind the package's name or folder, so this
 * is what puts the file where a record keeps it, relative to the repository. Read from the
 * workspace itself rather than listed by hand, so a package added tomorrow resolves.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The folders `pnpm-workspace.yaml` lists under `packages:`, each a path or a path ending in `/*`. */
function listed(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start === -1) return [];
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+['"]?([^'"#\s]+)['"]?\s*$/.exec(line);
    if (!item) break;
    globs.push(item[1]);
  }
  return globs;
}

/**
 * Every package of the workspace at `root` as `{ name, dir }`, `dir` relative to `root` with forward slashes.
 *
 * @returns {{ name: string, dir: string }[]}
 */
export function workspacePackages(root = repository) {
  const file = path.join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return [];
  const packages = [];
  for (const glob of listed(readFileSync(file, 'utf8'))) {
    const parent = glob.endsWith('/*') ? glob.slice(0, -2) : null;
    const dirs = parent === null ? [glob] : existsSync(path.join(root, parent)) ? readdirSync(path.join(root, parent), { withFileTypes: true }).filter((each) => each.isDirectory()).map((each) => `${parent}/${each.name}`) : [];
    for (const dir of dirs) {
      const manifest = path.join(root, dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof name === 'string') packages.push({ name, dir });
    }
  }
  return packages;
}
