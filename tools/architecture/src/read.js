/**
 * The only file that touches the checkout: reads the Worker config and every
 * workflow as text, and asks git which commit that is. It reads nothing else,
 * and nothing over a network. A file it needs and cannot read is a
 * ReadError, which the CLI turns into a failed run that writes nothing.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ReadError } from './model.js';

export const WRANGLER_CONFIG = 'apps/api/wrangler.jsonc';
export const WORKFLOWS_DIR = '.github/workflows';

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

export function readCheckout(root) {
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
    workflows: names.map((name) => ({ file: name, text: readText(root, `${WORKFLOWS_DIR}/${name}`) })),
    commit,
    date: commit ? git(root, ['show', '-s', '--format=%cI', commit]) : null,
    repo: process.env.GITHUB_REPOSITORY ?? null,
  };
}
