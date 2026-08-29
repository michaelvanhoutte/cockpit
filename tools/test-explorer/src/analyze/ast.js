/**
 * Shared TypeScript-compiler-API plumbing: parsing a file and resolving an
 * import specifier to an absolute path. Ported from
 * poc/coverage-explorer/src/analyze/signals.js, trimmed to what this tool
 * needs — purity/impure-globals detection is dropped, since obligation
 * inference (decision 3.3) is not part of this model (docs/test-explorer-spec.md §2).
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** @param {string} file absolute path */
export function parseFile(file) {
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

/** Branch-bearing syntax, for the merged-coverage cross-check in coverage.js. */
export const BRANCH_KINDS = new Set([
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

/**
 * @returns {string | null} absolute path of the imported file, if it resolves to one we know about
 * @param {string} spec import specifier text
 * @param {string} importer absolute path of the importing file
 * @param {Set<string>} files every known source file, absolute paths
 * @param {Map<string, string>} packageEntries workspace package name -> absolute entry file
 */
export function resolveImport(spec, importer, files, packageEntries) {
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
  const stripped = base.replace(/\.(js|jsx)$/, '');
  yield `${stripped}.ts`;
  yield `${stripped}.tsx`;
  yield base;
  yield path.join(stripped, 'index.ts');
  yield path.join(stripped, 'index.tsx');
}
