/**
 * Rule extraction: docs/test-explorer-spec.md §6.2.
 *
 * A static AST parse of every test file, never a test run — a report that
 * needs the suite to run is a report that stops working the moment the suite
 * breaks (the same reasoning poc/coverage-explorer's actuals pass used).
 *
 * Convention read here (docs/testing-strategy.md §9.1, "Tests are named in
 * the product's language, not the implementation's" — this superseded the
 * dotted `concept.subaction` convention this file originally shipped with;
 * see docs/test-explorer-spec.md §2a for what changed and why):
 *
 *   describe('Triage', () => {
 *     describe('a dismissed item leaves the lists but is never erased', () => {
 *       it('records when it was dismissed instead of dropping the item', () => { ... });
 *     });
 *   });
 *
 * Top-level `describe` = a **feature area** — undotted product language
 * ("Capture", "Triage", "Offline"), not an entity or a dotted grouping label.
 * Its direct-child `describe`s are rules, in product language. `it`/`it.each`/
 * `test` bodies anywhere under a rule are its cases; `.todo` bodies are
 * counted separately and do not make a rule "real" on their own.
 */

import ts from 'typescript';

/**
 * @param {string} relPath repo-relative test file path
 * @returns {{ column: import('../model.js').Column, level: string } | null}
 *   null when the path doesn't match any known test-folder shape (reported by the caller as a warning)
 */
export function columnAndLevelForTestFile(relPath) {
  let m = relPath.match(/^apps\/web\/tests\/([^/]+)\//);
  if (m) return { column: 'frontend', level: m[1] };

  if (relPath.startsWith('tests/e2e/')) return { column: 'browser', level: 'e2e' };

  m = relPath.match(/^packages\/connectors\/[^/]+\/tests\/contract\//);
  if (m) return { column: 'contract', level: 'contract' };

  // Everything else under apps/api/tests/** or packages/*/tests/** (excluding
  // the contract case above) counts as backend: apps/api is the one backend
  // service today, and packages/shared + packages/connectors/* unit tests are
  // backend-shaped code with no frontend equivalent. Revisit if a package
  // ever needs its own column.
  m = relPath.match(/^(?:apps\/api|packages\/[^/]+)\/tests\/([^/]+)\//);
  if (m) return { column: 'backend', level: m[1] };

  return null;
}

/**
 * @param {ts.SourceFile} source already parsed (parseFile is called once per test file by the
 *   caller and shared across extractRules/importsSelfFetch/markReached — see analyze/index.js)
 * @param {string} relFile repo-relative, for reporting
 * @param {import('../model.js').Column} column
 * @returns {{ rules: import('../model.js').Rule[], areasSeen: string[], warnings: string[] }}
 *   areasSeen is every top-level describe's text found, regardless of whether it produced a rule —
 *   an empty/not-yet-written describe still names a feature area that concepts.json must know about,
 *   which is what --check-concepts (§7) needs; using only `rules` here would miss exactly that case.
 */
export function extractRules(source, relFile, column) {
  const level = columnAndLevelForTestFile(relFile)?.level ?? 'unknown';
  /** @type {import('../model.js').Rule[]} */
  const rules = [];
  const areasSeen = [];
  const warnings = [];

  for (const stmt of source.statements) {
    const outer = describeCall(stmt);
    if (!outer) continue;

    const concept = outer.text;
    areasSeen.push(concept);

    const innerDescribes = directChildDescribes(outer.body);
    if (innerDescribes.length === 0) {
      const { cases, todoCases } = countCases(outer.body);
      if (cases === 0 && todoCases === 0) continue; // an empty/structural describe, nothing to report
      rules.push(rule(concept, concept, column, level, cases, todoCases, relFile, source, outer.node));
      continue;
    }

    for (const inner of innerDescribes) {
      const { cases, todoCases } = countCases(inner.body);
      if (cases === 0 && todoCases === 0) continue;
      rules.push(rule(concept, inner.text, column, level, cases, todoCases, relFile, source, inner.node));
    }
  }

  return { rules, areasSeen, warnings };
}

function rule(concept, statement, column, level, cases, todoCases, file, source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart());
  return { concept, statement, column, level, cases, todoCases, file, line: line + 1 };
}

/**
 * Recognizes `describe(...)` and the modifier forms `describe.skip/.only/.concurrent/.sequential(...)`
 * — mirroring countCases below, which already treats `it.skip`/`.only` as real, counted cases. Without
 * this, a temporarily-skipped top-level describe silently drops its whole feature area's rules with no
 * warning, inconsistent with how a skipped case is handled.
 *
 * @returns {{ text: string, body: ts.Node, node: ts.CallExpression } | null}
 */
function describeCall(stmt) {
  if (!ts.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  const isBareDescribe = ts.isIdentifier(callee) && callee.text === 'describe';
  const isModifiedDescribe =
    ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'describe';
  if (!isBareDescribe && !isModifiedDescribe) return null;
  const [nameArg, bodyArg] = expr.arguments;
  if (!nameArg || !ts.isStringLiteralLike(nameArg)) return null;
  if (!bodyArg || !(ts.isArrowFunction(bodyArg) || ts.isFunctionExpression(bodyArg))) return null;
  return { text: nameArg.text, body: bodyArg.body, node: expr };
}

/** Direct-child describe() calls inside a describe body (one level, not recursive). */
function directChildDescribes(body) {
  const out = [];
  const block = ts.isBlock(body) ? body.statements : [];
  for (const stmt of block) {
    const d = describeCall(stmt);
    if (d) out.push(d);
  }
  return out;
}

/** Counts it/test/it.each/test.each calls (real) and it.todo/test.todo calls (todo), anywhere under a node. */
function countCases(node) {
  let cases = 0;
  let todoCases = 0;
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && (callee.text === 'it' || callee.text === 'test')) {
        cases++;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === 'it' || callee.expression.text === 'test')
      ) {
        if (callee.name.text === 'todo') todoCases++;
        else cases++; // .each, .skip, .only, .concurrent, ... all still real written cases
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { cases, todoCases };
}
