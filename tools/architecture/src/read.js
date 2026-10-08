/**
 * The only file that touches the checkout: reads the Worker config, every
 * workflow and the description file as text, lists the folders the description
 * file says to look in, reads the source files in them, and asks git which
 * commit that is. It reads nothing else, and nothing over a network. A file it needs and cannot read is a
 * ReadError, which the CLI turns into a failed run that writes nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isCodeFile, isTestFile, parseDescription } from './description.js';
import { ReadError } from './errors.js';

export const WRANGLER_CONFIG = 'apps/api/wrangler.jsonc';
export const WORKFLOWS_DIR = '.github/workflows';
export const DESCRIPTION_FILE = 'tools/architecture/description.yml';

function readText(root, relative) {
  try {
    return readFileSync(path.join(root, relative), 'utf8');
  } catch (error) {
    throw new ReadError(relative, `cannot be read (${error.code ?? error.message})`);
  }
}

/** Quiet on failure: a checkout without git has no commit to name, which the page says. */
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const posix = (...parts) => parts.join('/');

function listDir(root, relative) {
  try {
    return readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    throw new ReadError(relative, `cannot be listed (${error.code ?? error.message})`);
  }
}

/** Every file under `relative` (or only those directly in it), as a path from the checkout's root; the text only of source files that are not tests. */
function filesIn(root, scan, relative, { recursive }) {
  const files = [];
  const walk = (directory) => {
    for (const entry of listDir(root, directory)) {
      if (scan.ignore.includes(entry.name)) continue;
      const file = posix(directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(file);
      } else if (entry.isFile()) {
        files.push({ file, text: isCodeFile(scan, file) && !isTestFile(scan, file) ? readText(root, file) : null });
      }
    }
  };
  walk(relative);
  return files;
}

/** The folders the description file says to look in, each as a candidate area with the files it holds. */
function discover(root, description) {
  const { scan } = description;
  const candidates = [];
  for (const where of description.discover) {
    if (!existsSync(path.join(root, where.path))) continue;
    if (where.as === 'one') {
      candidates.push({ path: where.path, package: false, role: where.role, files: filesIn(root, scan, where.path, { recursive: true }) });
      continue;
    }
    const folders = listDir(root, where.path).filter((entry) => entry.isDirectory() && !scan.ignore.includes(entry.name));
    for (const folder of folders) {
      const at = posix(where.path, folder.name);
      if (where.as === 'packages' && !existsSync(path.join(root, at, 'package.json'))) continue;
      candidates.push({ path: at, package: where.as === 'packages', role: where.role, files: filesIn(root, scan, at, { recursive: true }) });
    }
    if (where.rootFiles) candidates.push({ path: posix(where.path, '*'), package: false, role: where.role, files: filesIn(root, scan, where.path, { recursive: false }) });
  }
  return candidates;
}

export function readCheckout(root) {
  const description = { file: DESCRIPTION_FILE, text: readText(root, DESCRIPTION_FILE) };
  const candidates = discover(root, parseDescription(description.file, description.text));

  let names;
  try {
    names = readdirSync(path.join(root, WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch (error) {
    throw new ReadError(WORKFLOWS_DIR, `cannot be listed (${error.code ?? error.message})`);
  }
  if (names.length === 0) throw new ReadError(WORKFLOWS_DIR, 'holds no workflows');

  const commit = process.env.GITHUB_SHA || git(root, ['rev-parse', 'HEAD']);
  return {
    wrangler: { file: WRANGLER_CONFIG, text: readText(root, WRANGLER_CONFIG) },
    description,
    candidates,
    workflows: names.map((name) => ({ file: name, text: readText(root, `${WORKFLOWS_DIR}/${name}`) })),
    commit,
    date: commit ? git(root, ['show', '-s', '--format=%cI', commit]) : null,
    repo: process.env.GITHUB_REPOSITORY ?? null,
  };
}
