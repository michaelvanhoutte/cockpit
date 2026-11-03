//
// Fails CI when anything reaches a paid provider without going through the
// gateway ("Record every paid provider call through one gateway, and export
// the records as CSV", issue 902): a provider SDK import, use of the AI
// binding, or a provider's address, in any file that is not one the gateway
// lists as holding provider code. A provider added later is recorded from its
// first call because it cannot be called from anywhere else.
//
// What counts as a paid call (SDK names, addresses, bindings) is declared in
// scripts/provider-rules.json; the files that may make one are the paid-call
// rule in docs/architecture.yml, read as text because this job installs no YAML
// parser (tests/lint/import-rules.test.mjs holds that reading to the parser's).
// The functions are
// pure over the files' text; `readSources` is the one that touches the tree.
// Text rather than a parsed tree, so this runs in the checkout-only job
// `test:scripts` has, with no TypeScript installed.
//

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const RULES_PATH = 'scripts/provider-rules.json';
export const ARCHITECTURE_PATH = 'docs/architecture.yml';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** @param {string} path */
const slash = (path) => path.split(sep).join('/');

/**
 * The text with its comments blanked, so a sentence about a provider is not a
 * call to one. A `//` after a colon is a URL, not a comment.
 * @param {string} text
 */
export function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}

/**
 * Every module specifier a file names, by any of the forms that load one.
 * @param {string} text
 */
export function specifiersIn(text) {
  const found = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
  return found;
}

/** @param {string} specifier @param {string} sdk */
const namesSdk = (specifier, sdk) => (sdk.endsWith('/') ? specifier.startsWith(sdk) : specifier === sdk || specifier.startsWith(`${sdk}/`));

/**
 * Every way a file reaches a provider, one message per way.
 * @param {string} path repo-relative
 * @param {string} text
 * @param {Rules} rules
 * @returns {string[]}
 */
export function strayCallsIn(path, text, rules) {
  if (rules.holders.some((holder) => (holder.endsWith('/') ? path.startsWith(holder) : path === holder))) return [];
  const code = withoutComments(text);
  const found = [];
  for (const specifier of specifiersIn(code)) {
    if (rules.sdks.some((sdk) => namesSdk(specifier, sdk))) found.push(`${path}: imports the provider SDK ${specifier}`);
  }
  for (const binding of rules.bindings) {
    if (new RegExp(`\\.${binding}\\b|\\[['"]${binding}['"]\\]`).test(code)) found.push(`${path}: uses the ${binding} binding`);
  }
  for (const address of rules.addresses) {
    if (code.includes(address)) found.push(`${path}: names the provider address ${address}`);
  }
  return found;
}

/**
 * Every message over a set of files, and over the list of holders itself: a
 * holder that no longer exists is a hole nothing is guarding.
 * @param {{ path: string, text: string }[]} files
 * @param {Rules} rules
 * @param {(path: string) => boolean} exists
 */
export function strayCalls(files, rules, exists) {
  return [
    ...files.flatMap((file) => strayCallsIn(file.path, file.text, rules)),
    ...rules.holders.filter((holder) => !exists(holder)).map((holder) => `${ARCHITECTURE_PATH}: ${holder} is named by the paid-call rule and does not exist, remove it`),
  ];
}

/** @param {string} dir absolute @param {string[]} out */
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
}

/**
 * The product source under the folders to scan: files below a `src` folder,
 * never a test, which fakes providers at the network on purpose.
 * @param {string} root absolute repository root
 * @param {Rules} rules
 */
export function readSources(root, rules) {
  const files = [];
  for (const folder of rules.scan) {
    const start = join(root, folder);
    if (existsSync(start)) walk(start, files);
  }
  return files
    .map((file) => slash(relative(root, file)))
    .filter((path) => path.split('/').includes('src'))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}

/** @param {string} root */
export function readRules(root) {
  const detection = JSON.parse(readFileSync(join(root, RULES_PATH), 'utf8'));
  return { ...detection, holders: paidCallFiles(readFileSync(join(root, ARCHITECTURE_PATH), 'utf8')) };
}

/**
 * The files the paid-call rule (`check: paid-calls`) names, read from the rules
 * file's text. The rule's `files` must be one flow list on one line.
 * @param {string} text the rules file
 * @returns {string[]}
 */
export function paidCallFiles(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*check:\s*paid-calls\s*(#.*)?$/.test(line));
  if (at < 0) throw new Error(`${ARCHITECTURE_PATH}: no rule has check: paid-calls`);
  let start = at;
  while (start > 0 && !/^\s*-\s/.test(lines[start])) start -= 1;
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || lines[end].search(/\S/) > indent)) end += 1;
  for (const line of lines.slice(start, end)) {
    const match = /^\s*files:\s*\[(.*)\]\s*(#.*)?$/.exec(line);
    if (match) return match[1].split(',').map((file) => file.trim().replace(/^(['"])(.*)\1$/, '$2')).filter((file) => file !== '');
  }
  throw new Error(`${ARCHITECTURE_PATH}: the paid-call rule needs its files written as one list on one line, files: [a, b]`);
}

/** Every failure over the real tree. @param {string} root */
export function checkTree(root) {
  const rules = readRules(root);
  return strayCalls(readSources(root, rules), rules, (path) => existsSync(join(root, path)));
}

/**
 * @typedef {{ scan: string[], holders: string[], sdks: string[], addresses: string[], bindings: string[] }} Rules
 */
