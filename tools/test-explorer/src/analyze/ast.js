/**
 * Shared TypeScript-compiler-API plumbing: parsing a file. Ported from
 * poc/coverage-explorer/src/analyze/signals.js, trimmed to what this tool
 * needs — purity/impure-globals detection is dropped, since obligation
 * inference (decision 3.3) is not part of this model (docs/test-explorer-spec.md §2).
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';

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
