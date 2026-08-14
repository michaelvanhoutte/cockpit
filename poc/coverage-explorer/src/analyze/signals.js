/**
 * Signal extraction: the measurement half of decision 3.
 *
 * One pass with the TypeScript compiler API gives branch counts, the import
 * graph and the export list together, so purity and fan-in fall out of the same
 * walk. Nothing here decides anything; it only counts. What the counts oblige
 * lives in policy/obligations.js.
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IMPURE_IMPORTS, IMPURE_GLOBALS } from '../policy/obligations.js';

/**
 * Branch-bearing syntax. A cyclomatic proxy rather than true cyclomatic
 * complexity: we want "does this module make decisions", not a precise number.
 */
const BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
]);

const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** @param {string} file absolute path */
export function parse(file) {
  const text = readFileSync(file, 'utf8');
  return {
    text,
    source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file)),
  };
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

/**
 * Reads one file and returns everything the obligation rule needs from it,
 * minus fan-in and consequence, which are properties of the graph and of policy
 * rather than of the file.
 *
 * @param {string} file absolute path
 */
export function readFile(file) {
  const { text, source } = parse(file);

  let branches = 0;
  /** @type {string[]} */
  const imports = [];
  /** @type {Set<string>} */
  const globals = new Set();
  /** @type {string[]} */
  const exports = [];
  /** @type {boolean} */
  let typeOnly = true;

  const visit = (node) => {
    if (BRANCH_KINDS.has(node.kind)) branches++;
    if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) branches++;

    // Import specifiers, including `import type`, which we record but never
    // count as an impurity: a type import disappears at runtime.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) imports.push(node.moduleSpecifier.text);
    }

    // Bare identifier uses that name a known impure global. Property accesses
    // like `foo.fetch` are skipped, since only the global form matters.
    if (ts.isIdentifier(node) && IMPURE_GLOBALS.includes(node.text)) {
      const parent = node.parent;
      const isProperty = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isProperty) globals.add(node.text);
    }

    if (hasExportModifier(node)) {
      for (const name of exportedNames(node)) exports.push(name);
      if (!isTypeDeclaration(node)) typeOnly = false;
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return {
    branches,
    imports,
    impureGlobals: [...globals],
    exports,
    typeOnly,
    lines: text.split('\n').length,
  };
}

function hasExportModifier(node) {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isTypeDeclaration(node) {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.isVariableStatement(node) && false)
  );
}

function exportedNames(node) {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name ? [node.name.text] : [];
  }
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return [node.name.text];
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((d) => (ts.isIdentifier(d.name) ? d.name.text : null))
      .filter(Boolean);
  }
  return [];
}

/**
 * Decides purity from what a file reaches for. Returns the reason too, because
 * "impure" with no explanation is not actionable in a report.
 *
 * @param {{ imports: string[], impureGlobals: string[] }} file
 */
export function purity(file) {
  const badImport = file.imports.find((spec) =>
    IMPURE_IMPORTS.some((prefix) => spec === prefix || spec.startsWith(prefix)),
  );
  if (badImport) return { pure: false, reason: `imports ${badImport}` };
  if (file.impureGlobals.length) {
    return { pure: false, reason: `uses ${file.impureGlobals.join(', ')}` };
  }
  return { pure: true, reason: null };
}

/**
 * Fan-in across the whole set: how many other files import each file. Relative
 * specifiers are resolved against the importer; workspace specifiers are
 * resolved through the package map so that `@cockpit/shared` counts toward the
 * shared package's modules.
 *
 * @param {Map<string, { imports: string[] }>} files absolute path to parsed file
 * @param {Map<string, string>} packageEntries package name to absolute entry file
 */
export function fanIn(files, packageEntries) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const file of files.keys()) counts.set(file, 0);

  for (const [file, parsed] of files) {
    for (const spec of parsed.imports) {
      const target = resolve(spec, file, files, packageEntries);
      if (target && target !== file) counts.set(target, (counts.get(target) || 0) + 1);
    }
  }
  return counts;
}

/** @returns {string | null} absolute path of the imported file, if it is one of ours */
export function resolve(spec, importer, files, packageEntries) {
  if (spec.startsWith('.')) {
    // Source uses ESM-style .js specifiers that point at .ts files on disk.
    const base = path.resolve(path.dirname(importer), spec);
    for (const candidate of candidates(base)) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  }
  const entry = packageEntries.get(spec);
  return entry && files.has(entry) ? entry : null;
}

function* candidates(base) {
  const stripped = base.replace(/\.js$/, '');
  yield `${stripped}.ts`;
  yield `${stripped}.tsx`;
  yield base;
  yield path.join(stripped, 'index.ts');
  yield path.join(stripped, 'index.tsx');
}
