/**
 * The only file that touches the checkout: reads the Worker config, every
 * workflow and the description file as text, lists the folders the description
 * file says to look in, reads the source files in them, and asks git which
 * commit that is. Beyond the checkout it reads one thing: the previous report's model, from a file or one
 * address, and it draws an earlier commit by checking it out into a folder of its own. A file it needs and
 * cannot read is a ReadError, which the CLI turns into a failed run that writes nothing; the previous model
 * and the earlier commit are only ever "nothing to compare", never a failure.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** The name a package declares, which other packages import it by; none when the manifest names none. */
function packageNameOf(root, folder) {
  const file = posix(folder, 'package.json');
  try {
    const { name } = JSON.parse(readText(root, file));
    return typeof name === 'string' ? name : null;
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError(file, 'is not valid JSON');
  }
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
      candidates.push({ path: at, package: where.as === 'packages', packageName: where.as === 'packages' ? packageNameOf(root, at) : null, role: where.role, files: filesIn(root, scan, at, { recursive: true }) });
    }
    if (where.rootFiles) candidates.push({ path: posix(where.path, '*'), package: false, role: where.role, files: filesIn(root, scan, where.path, { recursive: false }) });
  }
  return candidates;
}

/**
 * @param {string} root
 * @param {{ commit?: string, fallbackDescription?: { file: string, text: string } }} [options] `commit` names the commit `root` holds when
 *   it is an earlier one, so the environment's own commit is not claimed for it; `fallbackDescription` is used when `root` has no description file.
 */
export function readCheckout(root, { commit: named, fallbackDescription } = {}) {
  const own = existsSync(path.join(root, DESCRIPTION_FILE));
  const description = !own && fallbackDescription ? fallbackDescription : { file: DESCRIPTION_FILE, text: readText(root, DESCRIPTION_FILE) };
  const candidates = discover(root, parseDescription(description.file, description.text));

  let names;
  try {
    names = readdirSync(path.join(root, WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch (error) {
    throw new ReadError(WORKFLOWS_DIR, `cannot be listed (${error.code ?? error.message})`);
  }
  if (names.length === 0) throw new ReadError(WORKFLOWS_DIR, 'holds no workflows');

  const commit = named ?? (process.env.GITHUB_SHA || git(root, ['rev-parse', 'HEAD']));
  return {
    wrangler: { file: WRANGLER_CONFIG, text: readText(root, WRANGLER_CONFIG) },
    description,
    candidates,
    workflows: names.map((name) => ({ file: name, text: readText(root, `${WORKFLOWS_DIR}/${name}`) })),
    commit,
    date: commit ? git(root, ['show', '-s', '--format=%cI', '--end-of-options', commit]) : null,
    repo: process.env.GITHUB_REPOSITORY ?? null,
    descriptionFromElsewhere: !own && Boolean(fallbackDescription),
  };
}

/** A full or abbreviated hex object id: the only shape of commit that is ever handed to git, so a value from a fetched model can never be read as an option. */
export const isObjectId = (value) => typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);

/** Whether the commit is one this checkout's history holds. */
export function hasCommit(root, commit) {
  return isObjectId(commit) && git(root, ['cat-file', '-t', '--end-of-options', `${commit}^{commit}`]) === 'commit';
}

/**
 * Runs `use(folder)` over a checkout of `commit` in a folder of its own, a detached git worktree, and removes
 * it afterwards whatever `use` does. Nothing in the working tree being drawn is touched.
 */
export async function atCommit(root, commit, use) {
  if (!isObjectId(commit)) throw new ReadError(String(commit), 'is not a commit id');
  const folder = path.join(mkdtempSync(path.join(tmpdir(), 'architecture-at-')), 'tree');
  try {
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', '--force', '--end-of-options', folder, commit], { stdio: 'ignore' });
  } catch {
    rmSync(path.dirname(folder), { recursive: true, force: true });
    throw new ReadError(commit, 'cannot be checked out');
  }
  try {
    return await use(folder);
  } finally {
    git(root, ['worktree', 'remove', '--force', '--end-of-options', folder]);
    git(root, ['worktree', 'prune']);
    rmSync(path.dirname(folder), { recursive: true, force: true });
  }
}

/**
 * The previous report's model from a file or an address. `{ model }` when it read; `{ first: true }` when there is
 * no report yet (no such file, a 404); `{ unreadable: reason }` for anything else. Never throws: a night whose
 * previous model cannot be had still draws its page.
 */
export async function readPreviousModel(location, { fetchImpl = fetch } = {}) {
  let text;
  try {
    if (/^https?:\/\//i.test(location)) {
      const response = await fetchImpl(location, { signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) return { first: true };
      if (!response.ok) return { unreadable: `the live report answered ${response.status}` };
      text = await response.text();
    } else {
      text = readFileSync(location, 'utf8');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { first: true };
    return { unreadable: `the previous model could not be fetched (${error.code ?? error.message})` };
  }
  try {
    const model = JSON.parse(text);
    return isObjectId(model?.drawnFrom?.commit) ? { model } : { unreadable: 'the previous model names no commit' };
  } catch {
    return { unreadable: 'the previous model is not valid JSON' };
  }
}
