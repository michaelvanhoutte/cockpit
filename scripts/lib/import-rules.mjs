//
// Fails CI when the core imports source code, or an API area imports against
// the agreed direction ("Fail CI when the core imports source code, or an area
// imports against the agreed direction", issue 876). The declaration it reads
// is docs/architecture.yml, which holds every structure rule with its reason;
// this reads only the rules it enforces (the ones with a `check`) and the
// accepted list, and maps them into one shape, `Rules`. The merge base's copy is
// read into the same shape from whichever file the base has.
//
// The functions are pure over an import list and the declaration; `readImports`
// is the one that touches the tree, and `shrinkFailures` compares the accepted
// entries the order forbids with the merge base's copy, which the caller reads.
//

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import ts from 'typescript';
import { LineCounter, parseDocument } from 'yaml';

import { placeMergeBase } from './merge-base.mjs';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']);

/** @param {string} path */
const slash = (path) => path.split(sep).join('/');

/**
 * Every module specifier a file names - static, type-only, re-exported or
 * dynamic with a literal - with whether it only names types, and the line of
 * each dynamic import whose argument is computed, which names no specifier.
 * @param {string} path
 * @param {string} text
 * @returns {{ specifiers: { specifier: string, typeOnly: boolean }[], computed: number[] }}
 */
export function importsOf(path, text) {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const specifiers = [];
  const computed = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      specifiers.push({ specifier: node.moduleSpecifier.text, typeOnly: Boolean(clause?.isTypeOnly) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      const [argument] = node.arguments;
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) specifiers.push({ specifier: argument.text, typeOnly: false });
      else computed.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { specifiers, computed };
}

/**
 * Every module specifier a file names - static, type-only, re-exported or
 * dynamic with a literal - with whether it only names types. A computed
 * dynamic import names none; `importsOf` reports those.
 * @param {string} path
 * @param {string} text
 * @returns {{ specifier: string, typeOnly: boolean }[]}
 */
export const specifiersOf = (path, text) => importsOf(path, text).specifiers;

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/**
 * Every string or template literal whose text is exactly a source id, found
 * by walking TypeScript's own parse of the file, so comments, identifiers and
 * the quotes inside a regular expression never count or hide a literal. A
 * template literal is read chunk by chunk, so `${x}teams` and `teams` both
 * hold the id. Exact, not "contains": a literal holding the id inside longer
 * text (copy that says "Connect your Gmail", a store key such as
 * `gmail-check-account`, a path) is not the id being used as a value.
 * @param {string} path
 * @param {string} text
 * @param {string[]} ids
 * @returns {{ line: number, id: string }[]}
 */
export function namedSourcesIn(path, text, ids) {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const found = [];
  const visit = (node) => {
    if (LITERAL_KINDS.has(node.kind) && ids.includes(node.text)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, id: node.text });
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
  const packages = new Set(sourcePackages(root, rules));
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

/**
 * The registered source ids a core file's code may not write as a string:
 * every declared source that is not an engine. An engine is named by the engine
 * list and, until "Decide how Claude Code and other outbound integrations sit
 * behind a boundary" (issue 879), by the core's own Claude Code code.
 * @param {Rules} rules
 */
export const namedSourceIds = (rules) => Object.entries(rules.sources).flatMap(([id, source]) => (source.engine ? [] : [id]));

/**
 * Every core source file whose code writes a registered source id as a string,
 * except the files `rules.names.exempt` lists (the migrations, the guest
 * demo's seed) and the engine list. Tests under the core's folders are not
 * scanned: only `src`.
 * @param {string} root absolute repository root
 * @param {Rules} rules
 * @returns {{ file: string, line: number, id: string }[]}
 */
export function readNamedSources(root, rules) {
  const ids = namedSourceIds(rules);
  const exempt = new Set([...(rules.names?.exempt ?? []), ...(rules.engines ?? [])]);
  const found = [];
  for (const folder of rules.core) {
    const files = [];
    const src = join(root, folder, 'src');
    if (existsSync(src)) walk(src, files);
    for (const full of files) {
      const file = slash(relative(root, full));
      if (exempt.has(file)) continue;
      for (const { line, id } of namedSourcesIn(file, readFileSync(full, 'utf8'), ids)) found.push({ file, line, id });
    }
  }
  return found;
}

/** @param {{ file: string, line: number, id: string }} named */
export const namedSourceFailure = ({ file, line, id }) =>
  `${file}:${line} writes the source id "${id}" as a string: the core may not name a registered source`;

/**
 * Every package that is a source: those the declaration names, and every
 * workspace package under packages/connectors, declared or not.
 * @param {string} root absolute repository root
 * @param {Rules} rules
 */
export function sourcePackages(root, rules) {
  const found = new Set(Object.values(rules.sources).flatMap((source) => (source.package ? [source.package] : [])));
  const folder = join(root, 'packages/connectors');
  if (existsSync(folder)) {
    for (const name of readdirSync(folder)) {
      const manifest = join(folder, name, 'package.json');
      if (existsSync(manifest)) found.add(JSON.parse(readFileSync(manifest, 'utf8')).name);
    }
  }
  return [...found];
}

/** Lower-case letters and digits only, so `ConnectClaudeCode` names `claude-code`. */
const squash = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The declared sources a file's path names: one of its folders, or its file
 * name without the extension, contains the source's name. The path as a whole
 * is not squashed, so a name cannot be spelled across two segments.
 * @param {string} path
 * @param {Rules} rules
 */
export function sourcesNamedBy(path, rules) {
  const segments = path.split('/').map((segment, index, all) => squash(index === all.length - 1 ? segment.replace(/\.[^.]*$/, '') : segment));
  return Object.keys(rules.sources).filter((id) => segments.some((segment) => segment.includes(squash(id))));
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
  const add = (from, to, rule) => {
    const key = `${from} -> ${to}`;
    if (!breaches.has(key)) breaches.set(key, { from, to, toArea: areaOf(to, rules), rule });
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
          const engineList = rules.sources[source]?.engine === true && (rules.engines ?? []).includes(importer);
          if (!importerNames.includes(source) && importer !== rules.registry && !engineList) {
            add(importer, imported, `the core may not import ${source} code from a file not named for ${source}`);
          }
        }
      }
    }
    // Rule 1: the direction between API areas.
    const from = areaOf(importer, rules);
    const to = areaOf(imported, rules);
    if (from === null || to === null || from === 'root' || from === to) continue;
    if (to === 'root') {
      const file = imported.slice(rules.areas.folder.length + 1);
      if (!rules.areas.sharedRoot.includes(file)) add(importer, imported, `${from} may not import the composition root file ${file}`);
      continue;
    }
    if (!rank.has(from)) add(importer, imported, `${from} is not a declared area`);
    else if (!rank.has(to)) add(importer, imported, `${to} is not a declared area`);
    else if (rank.get(to) <= rank.get(from)) add(importer, imported, `${from} may not import ${to}`);
  }
  return [...breaches.values()];
}

/**
 * An allowlist entry or a breach, keyed by the importing file and the area it
 * imports (the file, where the import is not into an API area).
 * @param {{ from: string, to: string, toArea?: string | null }} entry
 */
const keyOf = (entry) => `${entry.from} -> ${entry.toArea ?? entry.to}`;

/**
 * Breaches not on the allowlist, and allowlist entries whose breach is gone.
 * @param {Breach[]} breaches
 * @param {{ from: string, to: string }[]} allowlist
 * @returns {string[]}
 */
export function failuresAgainst(breaches, allowlist) {
  const allowed = new Set(allowlist.map(keyOf));
  const present = new Set(breaches.map(keyOf));
  return [
    ...breaches.filter((b) => !allowed.has(keyOf(b))).map((b) => `${b.from} imports ${b.to}: ${b.rule}`),
    ...allowlist
      .filter((entry) => !present.has(keyOf(entry)))
      .map((entry) => `accepted entry no longer needed, remove it: ${keyOf(entry)}`),
  ];
}

/**
 * Entries a change added to the accepted imports the order forbids, which is
 * how a build would silence a breach.
 * @param {{ from: string, to: string }[]} allowlist
 * @param {{ from: string, to: string }[]} baseAllowlist the merge base's copy
 * @returns {string[]}
 */
export function shrinkFailures(allowlist, baseAllowlist) {
  const base = new Set(baseAllowlist.map(keyOf));
  return allowlist
    .filter((entry) => !base.has(keyOf(entry)))
    .map((entry) => `accepted entry is not in the merge base's accepted list, the list may only shrink: ${keyOf(entry)}`);
}

/**
 * What a change relaxed in the rules themselves, against the merge base's copy.
 * Additions are fine (a source, a core folder, an area anywhere that keeps every
 * "above" relation the base had); removing a source or core folder, changing the
 * registry, widening the root lists or breaking a relation is not.
 * @param {Rules} rules
 * @param {Rules} base
 * @returns {string[]}
 */
export function relaxations(rules, base) {
  const out = [];
  for (const id of Object.keys(base.sources)) {
    if (!(id in rules.sources)) out.push(`source ${id} was removed`);
    else if (base.sources[id].package && base.sources[id].package !== rules.sources[id].package) out.push(`source ${id} no longer names its package ${base.sources[id].package}`);
    else if (base.engines && rules.sources[id].engine && !base.sources[id].engine) out.push(`source ${id} became an engine`);
  }
  for (const folder of base.core) if (!rules.core.includes(folder)) out.push(`core folder ${folder} was removed`);
  for (const file of base.engines ?? []) if (!(rules.engines ?? []).includes(file)) out.push(`engine list ${file} was removed`);
  for (const file of rules.engines ?? []) if (base.engines && !base.engines.includes(file)) out.push(`${file} was added to the engine lists`);
  for (const file of rules.names?.exempt ?? []) if (base.names && !base.names.exempt.includes(file)) out.push(`${file} was added to the files that may name a source`);
  if (rules.registry !== base.registry) out.push(`the registry changed from ${base.registry} to ${rules.registry}`);
  if (rules.areas.folder !== base.areas.folder) out.push(`the areas folder changed from ${base.areas.folder} to ${rules.areas.folder}`);
  for (const file of rules.areas.root) if (!base.areas.root.includes(file)) out.push(`${file} was added to the composition root`);
  for (const file of rules.areas.sharedRoot) if (!(base.areas.sharedRoot ?? []).includes(file)) out.push(`${file} was added to the root files any area may import`);
  const rank = (declaration) => new Map(declaration.areas.order.flatMap((tier, index) => tier.map((area) => [area, index])));
  const before = rank(base);
  const now = rank(rules);
  const areas = [...before.keys()];
  for (const a of areas) {
    for (const b of areas) {
      if (a >= b) continue;
      const wasAbove = before.get(a) < before.get(b);
      const wasLevel = before.get(a) === before.get(b);
      const holds = now.has(a) && now.has(b) && (wasAbove ? now.get(a) < now.get(b) : wasLevel ? now.get(a) === now.get(b) : now.get(a) > now.get(b));
      if (!holds) out.push(wasAbove ? `${a} no longer stays above ${b}` : wasLevel ? `${a} and ${b} no longer share a tier` : `${b} no longer stays above ${a}`);
    }
  }
  // The layer rules bind from the first merge base that has the layer-calls rule.
  if (base.layers) {
    if (!rules.layers) out.push('the rule with check: layer-calls was removed');
    else {
      for (const call of rules.layers.known) if (!base.layers.known.includes(call)) out.push(`known breach is not in the merge base's known breaches, the list may only shrink: ${call}`);
    }
  }
  return out;
}

/**
 * @typedef {{ sources: Record<string, { package?: string }>, core: string[], registry: string,
 *   areas: { folder: string, root: string[], sharedRoot: string[], order: string[][] }, allowlist: { from: string, to: string }[],
 *   layers?: { known: string[] } | null }} Rules
 * @typedef {{ importer: string, imported: string, typeOnly: boolean }} Import
 * @typedef {{ from: string, to: string, rule: string }} Breach
 */

export const RULES_PATH = 'docs/architecture.yml';
/** Where the rules were kept before the rules file; a merge base may still hold them here. */
export const OLD_RULES_PATH = 'scripts/import-rules.json';

/**
 * The parsed rules file. A file that does not parse throws, naming the file and
 * the line.
 * @param {string} text
 * @param {string} [path]
 */
export function parseRulesFile(text, path = RULES_PATH) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    const [error] = doc.errors;
    const { line } = lineCounter.linePos(error.pos[0]);
    throw new Error(`${path}:${line}: ${error.message.split('\n')[0]}`);
  }
  return doc.toJS() ?? {};
}

/**
 * The layers' parts as the folders of the API they sit in: part id to areas.
 * @param {any} file
 * @param {string} folder
 */
function partAreas(file, folder) {
  const areas = new Map();
  for (const layer of Object.values(file.cockpit?.layers ?? {})) {
    for (const [id, part] of Object.entries(layer.parts ?? {})) {
      const codes = [part.code ?? []].flat();
      areas.set(id, codes.filter((code) => code.startsWith(`${folder}/`)).map((code) => code.slice(folder.length + 1).split('/')[0]));
    }
  }
  return areas;
}

/**
 * The rules the import check enforces, from the parsed rules file, in the one
 * shape the check reads. Setting `agreed` or rewording a reason changes nothing
 * here, so it can never read as a relaxation.
 * @param {any} file the parsed rules file
 * @param {(path: string) => string | null} [readText] a repo-relative file's text, or null; names the source packages
 * @returns {Rules}
 */
export function rulesFromFile(file, readText = () => null) {
  const rules = file.cockpit?.rules ?? [];
  const checked = (name) => {
    const found = rules.find((rule) => rule.check === name);
    if (!found) throw new Error(`${RULES_PATH}: no rule has check: ${name}`);
    return found;
  };
  const order = checked('import-order');
  const imports = checked('connector-imports');
  const sources = {};
  for (const [id, source] of Object.entries(file.cockpit?.sources ?? {})) {
    sources[id] = {};
    if (source.engine) sources[id].engine = true;
    if (source.package) {
      const manifest = readText(`${source.package}/package.json`);
      sources[id].package = manifest ? JSON.parse(manifest).name : source.package;
    }
  }
  const declared = {
    sources,
    core: imports.core,
    registry: imports.files[0],
    areas: { folder: order.folder, root: order['root files'], sharedRoot: order['shared root files'], order: order.order },
    names: { exempt: Object.keys(checked('source-names').except ?? {}) },
    engines: checked('engine-lists').files,
    allowlist: [],
  };
  // The layer-calls check runs in tools/architecture; here is only what may not grow against the merge base: every known
  // breach per file. An accepted call may be added, its pull request being its review. Null where the file has no
  // layer-calls rule yet.
  declared.layers = rules.some((rule) => rule.check === 'layer-calls')
    ? { known: (file.cockpit?.['known breaches'] ?? []).flatMap((entry) => (entry.files ?? []).map((importer) => `${entry.from} -> ${entry.to} in ${importer}`)) }
    : null;
  const rank = new Map(declared.areas.order.flatMap((tier, index) => tier.map((area) => [area, index])));
  const areas = partAreas(file, declared.areas.folder);
  for (const entry of file.cockpit?.accepted ?? []) {
    for (const from of areas.get(entry.from) ?? []) {
      for (const to of areas.get(entry.to) ?? []) {
        if (from === to || !rank.has(from) || !rank.has(to) || rank.get(to) > rank.get(from)) continue;
        for (const importer of entry.files ?? []) declared.allowlist.push({ from: importer, to });
      }
    }
  }
  return declared;
}

/**
 * The rules as `scripts/import-rules.json` held them, in the same shape.
 * @param {any} json
 * @returns {Rules}
 */
export function rulesFromOldJson(json) {
  return { ...json, layers: null, allowlist: (json.allowlist ?? []).map((entry) => ({ from: entry.from, to: areaOf(entry.to, json) ?? entry.to })) };
}

/**
 * Every rule, entry and call in the rules file that has neither a reason nor a
 * question, or no agreed mark, naming it.
 * @param {any} file the parsed rules file
 * @returns {string[]}
 */
export function shapeFailures(file) {
  const failures = [];
  const check = (name, item) => {
    const said = (value) => typeof value === 'string' && value.trim() !== '';
    if (!said(item?.reason) && !said(item?.question)) failures.push(`${RULES_PATH}: ${name} has neither a reason nor a question`);
    if (typeof item?.agreed !== 'boolean') failures.push(`${RULES_PATH}: ${name} has no agreed mark, true or false`);
  };
  const named = (item) => item.rule ?? `${item.from} -> ${item.to}`;
  for (const item of file['between services'] ?? []) check(`the rule "${named(item)}"`, item);
  for (const item of file.cockpit?.rules ?? []) check(`the rule "${named(item)}"`, item);
  for (const item of file.cockpit?.accepted ?? []) check(`the accepted entry ${named(item)}`, item);
  for (const item of file['harness-monitor']?.rules ?? []) check(`the rule "${named(item)}"`, item);
  for (const [layer, body] of Object.entries(file.cockpit?.layers ?? {})) {
    for (const [target, item] of Object.entries(body.calls ?? {})) check(`${layer} calling ${target}`, item);
  }
  for (const [target, item] of Object.entries(file['android-widget']?.calls ?? {})) check(`the widget calling ${target}`, item);
  return failures;
}

/**
 * The rules at a checkout.
 * @param {string} root
 * @returns {Rules}
 */
export function readRules(root) {
  const readText = (path) => {
    if (existsSync(join(root, path))) return readFileSync(join(root, path), 'utf8');
    // A source whose manifest is gone would be guarded under its folder path, not its package name.
    if (path.endsWith('/package.json')) throw new Error(`${RULES_PATH}: ${path} does not exist, so the source's package name cannot be read`);
    return null;
  };
  return rulesFromFile(parseRulesFile(readFileSync(join(root, RULES_PATH), 'utf8')), readText);
}

/** Every failure over the real tree, given the base copy's rules or why there are none. */
export function checkTree(root, base) {
  let rules;
  try {
    rules = readRules(root);
  } catch (error) {
    return [error.message];
  }
  const failures = [
    ...failuresAgainst(findBreaches(readImports(root, rules), rules), rules.allowlist),
    ...readNamedSources(root, rules).map(namedSourceFailure),
  ];
  if (base.error) failures.push(`cannot read the merge base's copy of the rules, so the relaxation check cannot run: ${base.error}`);
  else if (base.rules) failures.push(...shrinkFailures(rules.allowlist, base.rules.allowlist), ...relaxations(rules, base.rules));
  return failures;
}

/**
 * The merge base's copy of the rules, for `checkTree`, from whichever file the
 * base has: the rules file, or the import rules kept before it.
 * A pull request has its base placed by scripts/lib/merge-base.mjs, and one that
 * cannot be placed or read is an error, never a skipped check. A push in CI has
 * no base to compare with. Anywhere else (a session's own checkout) the base is
 * `git merge-base HEAD origin/main`, and a checkout with no `main` to name is
 * skipped rather than failed, since there is nothing to fetch it from.
 * @param {{ event?: string, ci: boolean, git: (args: string[]) => string }} how
 * @returns {{ rules: Rules | null, error?: string, skipped?: string }}
 */
export function readBase({ event, ci, git }) {
  let base = null;
  if (event === 'pull_request') {
    base = placeMergeBase(event, git, () => {}).mergeBase;
    if (!base) return { rules: null, error: 'no merge base could be placed for this pull request (is the checkout shallow?)' };
  } else if (ci) {
    return { rules: null, skipped: 'not a pull request, so there is no merge base to compare with' };
  } else {
    for (const against of ['origin/main', 'main']) {
      try {
        base = git(['merge-base', 'HEAD', against]);
        break;
      } catch {
        // try the next name
      }
    }
    if (!base) return { rules: null, skipped: 'no main to take a merge base from' };
  }
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
    const shown = (path) => {
      try {
        return git(['show', `${base}:${path}`]);
      } catch {
        return null;
      }
    };
    if (git(['ls-tree', base, '--', RULES_PATH]) !== '') {
      return { rules: rulesFromFile(parseRulesFile(git(['show', `${base}:${RULES_PATH}`]), `${RULES_PATH} at the merge base`), shown) };
    }
    if (git(['ls-tree', base, '--', OLD_RULES_PATH]) !== '') return { rules: rulesFromOldJson(JSON.parse(git(['show', `${base}:${OLD_RULES_PATH}`]))) };
    return { rules: null, skipped: `neither ${RULES_PATH} nor ${OLD_RULES_PATH} exists at the merge base yet` };
  } catch (error) {
    return { rules: null, error: error.message };
  }
}
