//
// Fails CI when the core imports source code, or an API area imports against
// the agreed direction ("Fail CI when the core imports source code, or an area
// imports against the agreed direction", issue 876). The declaration it reads
// is scripts/import-rules.json: the sources, the core, the direction, the one
// registry file and the allowlist of today's breaches.
//
// The functions are pure over an import list and the declaration; `readImports`
// is the one that touches the tree, and `shrinkFailures` compares the allowlist
// with the merge base's copy, which the caller reads.
//

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import ts from 'typescript';

import { placeMergeBase } from './merge-base.mjs';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']);

/** @param {string} path */
const slash = (path) => path.split(sep).join('/');

/**
 * Every module specifier a file names - static, type-only, re-exported or
 * dynamic - with whether it only names types.
 * @param {string} path
 * @param {string} text
 * @returns {{ specifier: string, typeOnly: boolean }[]}
 */
export function specifiersOf(path, text) {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const found = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: Boolean(clause?.isTypeOnly) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The file a relative specifier names, as a repo-relative path, or null.
 * @param {string} importer repo-relative
 * @param {string} specifier
 * @param {(path: string) => boolean} exists repo-relative
 */
export function resolveRelative(importer, specifier, exists) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const stripped = base.replace(/\.(m?js|jsx)$/, '');
  const candidates = [base, ...['.ts', '.tsx', '.mts'].map((e) => stripped + e), ...['.ts', '.tsx'].map((e) => `${base}/index${e}`)];
  return candidates.find((candidate) => exists(candidate) && SOURCE_EXTENSIONS.has(posix.extname(candidate))) ?? null;
}

/**
 * @param {string} dir absolute
 * @param {string[]} out
 */
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(posix.extname(name)) && !name.endsWith('.d.ts')) out.push(full);
  }
}

/**
 * Every import of the core's source files, resolved to a repo-relative file or
 * to a declared source's package name. Specifiers that name neither are left
 * out. Tests under the core's folders are not scanned: only `src`.
 * @param {string} root absolute repository root
 * @param {Rules} rules
 * @returns {Import[]}
 */
export function readImports(root, rules) {
  const packages = new Set(sourcePackages(rules));
  const exists = (path) => existsSync(join(root, path));
  const imports = [];
  for (const folder of rules.core) {
    const files = [];
    const src = join(root, folder, 'src');
    if (existsSync(src)) walk(src, files);
    for (const file of files) {
      const importer = slash(relative(root, file));
      for (const { specifier, typeOnly } of specifiersOf(importer, readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.')) {
          const imported = resolveRelative(importer, specifier, exists);
          if (imported) imports.push({ importer, imported, typeOnly });
        } else {
          const name = specifier.split('/').slice(0, 2).join('/');
          if (packages.has(name)) imports.push({ importer, imported: name, typeOnly });
        }
      }
    }
  }
  return imports;
}

/** @param {Rules} rules */
function sourcePackages(rules) {
  return Object.values(rules.sources).flatMap((source) => (source.package ? [source.package] : []));
}

/** Lower-case letters and digits only, so `ConnectClaudeCode` names `claude-code`. */
const squash = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The declared sources a file's path names.
 * @param {string} path
 * @param {Rules} rules
 */
export function sourcesNamedBy(path, rules) {
  const squashed = squash(path);
  return Object.keys(rules.sources).filter((id) => squashed.includes(squash(id)));
}

/**
 * The API area a file belongs to, 'root' for a composition-root file, or null
 * when the file is not in the API's source.
 * @param {string} path
 * @param {Rules} rules
 */
export function areaOf(path, rules) {
  const prefix = `${rules.areas.folder}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest.includes('/')) return rules.areas.root.includes(rest) ? 'root' : rest;
  return rest.split('/')[0];
}

/**
 * Every import that breaks a rule, one per importing and imported file pair.
 * @param {Import[]} imports
 * @param {Rules} rules
 * @returns {Breach[]}
 */
export function findBreaches(imports, rules) {
  const order = rules.areas.order;
  const rank = new Map(order.flatMap((tier, index) => tier.map((area) => [area, index])));
  const breaches = new Map();
  const add = (importer, imported, rule) => {
    const key = `${importer} -> ${imported}`;
    if (!breaches.has(key)) breaches.set(key, { importer, imported, rule });
  };
  for (const { importer, imported } of imports) {
    // Rule 2: source code in the core.
    if (imported.startsWith('@')) {
      if (importer !== rules.registry) {
        add(importer, imported, `the core may not import a source's package; only ${rules.registry} may`);
      }
    } else {
      const named = sourcesNamedBy(imported, rules);
      if (named.length > 0) {
        const importerNames = sourcesNamedBy(importer, rules);
        for (const source of named) {
          if (!importerNames.includes(source) && importer !== rules.registry) {
            add(importer, imported, `the core may not import ${source} code from a file not named for ${source}`);
          }
        }
      }
    }
    // Rule 1: the direction between API areas.
    const from = areaOf(importer, rules);
    const to = areaOf(imported, rules);
    if (from === null || to === null || from === 'root' || to === 'root' || from === to) continue;
    if (!rank.has(from)) add(importer, imported, `${from} is not a declared area`);
    else if (!rank.has(to)) add(importer, imported, `${to} is not a declared area`);
    else if (rank.get(to) <= rank.get(from)) add(importer, imported, `${from} may not import ${to}`);
  }
  return [...breaches.values()];
}

/** @param {{ from: string, to: string }} entry */
const keyOf = (entry) => `${entry.from} -> ${entry.to}`;

/**
 * Breaches not on the allowlist, and allowlist entries whose breach is gone.
 * @param {Breach[]} breaches
 * @param {{ from: string, to: string }[]} allowlist
 * @returns {string[]}
 */
export function tree(breaches, allowlist) {
  const allowed = new Set(allowlist.map(keyOf));
  const present = new Set(breaches.map((b) => keyOf({ from: b.importer, to: b.imported })));
  return [
    ...breaches
      .filter((b) => !allowed.has(keyOf({ from: b.importer, to: b.imported })))
      .map((b) => `${b.importer} imports ${b.imported}: ${b.rule}`),
    ...allowlist
      .filter((entry) => !present.has(keyOf(entry)))
      .map((entry) => `allowlist entry no longer needed, remove it: ${keyOf(entry)}`),
  ];
}

/**
 * Allowlist entries a change added, which is how a build would silence a breach.
 * @param {{ from: string, to: string }[]} allowlist
 * @param {{ from: string, to: string }[]} baseAllowlist the merge base's copy
 * @returns {string[]}
 */
export function shrinkFailures(allowlist, baseAllowlist) {
  const base = new Set(baseAllowlist.map(keyOf));
  return allowlist
    .filter((entry) => !base.has(keyOf(entry)))
    .map((entry) => `allowlist entry is not in the merge base's allowlist, the list may only shrink: ${keyOf(entry)}`);
}

/**
 * The merge base's copy of the declaration's allowlist.
 * @param {string} text the base copy's JSON, or null when the file did not exist there
 * @returns {{ from: string, to: string }[] | null}
 */
export function baseAllowlistOf(text) {
  if (text === null) return null;
  return JSON.parse(text).allowlist;
}

/**
 * @typedef {{ sources: Record<string, { package?: string }>, core: string[], registry: string,
 *   areas: { folder: string, root: string[], order: string[][] }, allowlist: { from: string, to: string }[] }} Rules
 * @typedef {{ importer: string, imported: string, typeOnly: boolean }} Import
 * @typedef {{ importer: string, imported: string, rule: string }} Breach
 */

export const RULES_PATH = 'scripts/import-rules.json';

/** @param {string} root */
export function readRules(root) {
  return JSON.parse(readFileSync(join(root, RULES_PATH), 'utf8'));
}

/** Every failure over the real tree, given the base copy's allowlist or why there is none. */
export function checkTree(root, base) {
  const rules = readRules(root);
  const failures = tree(findBreaches(readImports(root, rules), rules), rules.allowlist);
  if (base.error) failures.push(`cannot read the merge base's copy of ${RULES_PATH}, so the shrink-only check cannot run: ${base.error}`);
  else if (base.allowlist) failures.push(...shrinkFailures(rules.allowlist, base.allowlist));
  return failures;
}

/**
 * The merge base's copy of the declaration's allowlist, for `checkTree`.
 * A pull request has its base placed by scripts/lib/merge-base.mjs, and one that
 * cannot be placed or read is an error, never a skipped check. A push in CI has
 * no base to compare with. Anywhere else (a session's own checkout) the base is
 * `git merge-base HEAD origin/main`, and a checkout with no `main` to name is
 * skipped rather than failed, since there is nothing to fetch it from.
 * @param {{ event?: string, ci: boolean, git: (args: string[]) => string }} how
 * @returns {{ allowlist: { from: string, to: string }[] | null, error?: string, skipped?: string }}
 */
export function readBase({ event, ci, git }) {
  let base = null;
  if (event === 'pull_request') {
    base = placeMergeBase(event, git, () => {}).mergeBase;
    if (!base) return { allowlist: null, error: 'no merge base could be placed for this pull request (is the checkout shallow?)' };
  } else if (ci) {
    return { allowlist: null, skipped: 'not a pull request, so there is no merge base to compare with' };
  } else {
    for (const against of ['origin/main', 'main']) {
      try {
        base = git(['merge-base', 'HEAD', against]);
        break;
      } catch {
        // try the next name
      }
    }
    if (!base) return { allowlist: null, skipped: 'no main to take a merge base from' };
  }
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
    if (git(['ls-tree', base, '--', RULES_PATH]) === '') return { allowlist: null, skipped: `${RULES_PATH} does not exist at the merge base yet` };
    return { allowlist: baseAllowlistOf(git(['show', `${base}:${RULES_PATH}`])) };
  } catch (error) {
    return { allowlist: null, error: error.message };
  }
}
