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
 * Maps a test file's path to one of model.js's LEVEL_IDS. The six testing-strategy
 * levels attach to real, distinct folders (testing-strategy.md §9); Contract is
 * the seventh, scheduled-only tier (§3.3).
 *
 * @param {string} relPath repo-relative test file path
 * @returns {string | null} one of LEVEL_IDS, or null when the path doesn't match any
 *   known test-folder shape (reported by the caller as a warning)
 */
export function levelForTestFile(relPath) {
  let m = relPath.match(/^apps\/web\/tests\/([^/]+)\//);
  if (m) {
    if (m[1] === 'unit') return 'F1';
    if (m[1] === 'service') return 'F2';
    return null;
  }

  if (relPath.startsWith('tests/e2e/')) return 'F3';

  if (/^packages\/connectors\/[^/]+\/tests\/contract\//.test(relPath)) return 'Contract';

  // apps/api/tests/** and packages/*/tests/** (excluding the connector-contract
  // case above): apps/api is the one backend service today, and
  // packages/shared/packages/connectors/* unit/integration tests are
  // backend-shaped code with no frontend equivalent.
  m = relPath.match(/^(?:apps\/api|packages\/[^/]+)\/tests\/([^/]+)\//);
  if (m) {
    if (m[1] === 'unit') return 'L1';
    if (m[1] === 'integration') return 'L2';
    if (m[1] === 'system') return 'L3';
    return null;
  }

  return null;
}

/**
 * @param {ts.SourceFile} source already parsed (parseFile is called once per test file by the
 *   caller and shared across extractRules/importsSelfFetch/markReached — see analyze/index.js)
 * @param {string} relFile repo-relative, for reporting
 * @param {string} level one of LEVEL_IDS, from levelForTestFile(relFile)
 * @returns {{ rules: import('../model.js').Rule[], areasSeen: string[], warnings: string[] }}
 *   areasSeen is every top-level describe's text found, regardless of whether it produced a rule —
 *   an empty/not-yet-written describe still names a feature area that concepts.json must know about,
 *   which is what --check-concepts (§7) needs; using only `rules` here would miss exactly that case.
 */
export function extractRules(source, relFile, level) {
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
      const { cases, todoCases } = collectCases(outer.body, relFile, source);
      if (cases.length === 0 && todoCases.length === 0) continue; // an empty/structural describe, nothing to report
      rules.push(rule(concept, concept, level, cases, todoCases, relFile, source, outer.node));
      continue;
    }

    for (const inner of innerDescribes) {
      const { cases, todoCases } = collectCases(inner.body, relFile, source);
      if (cases.length === 0 && todoCases.length === 0) continue;
      rules.push(rule(concept, inner.text, level, cases, todoCases, relFile, source, inner.node));
    }
  }

  return { rules, areasSeen, warnings };
}

function rule(concept, statement, level, cases, todoCases, file, source, node) {
  const line = lineOf(source, node);
  return { concept, statement, level, cases, todoCases, file, line };
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/** The case's own description, verbatim: a plain string as written, or the raw source text of a template literal. */
function caseText(nameArg, source) {
  if (!nameArg) return '(unnamed case)';
  if (ts.isStringLiteralLike(nameArg)) return nameArg.text;
  return nameArg.getText(source);
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

/**
 * Collects it/test/it.each/test.each calls (real) and it.todo/test.todo calls (todo), anywhere
 * under a node, each as a `{ text, file, line }` — the case's own description and location, not
 * just a count, so the report can show what a case actually says (docs/test-explorer-spec.md §2d).
 *
 * `it.each(table)(name, fn)` is two chained calls, not one: the outer call's callee is itself a
 * CallExpression (`it.each(table)`), whose own callee is the `it.each` property access. Matching
 * only a bare PropertyAccessExpression callee (as `it.skip(...)`/`it.only(...)` are) would instead
 * match the *inner* call — `it.each(table)` — treating the whole data table as the case name and
 * miscounting one case where there may be many. Handled as its own case below.
 */
function collectCases(node, relFile, source) {
  const cases = [];
  const todoCases = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const [nameArg] = n.arguments;
      const caseRef = () => ({ text: caseText(nameArg, source), file: relFile, line: lineOf(source, n) });

      if (ts.isIdentifier(callee) && (callee.text === 'it' || callee.text === 'test')) {
        cases.push(caseRef());
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === 'it' || callee.expression.text === 'test') &&
        callee.name.text !== 'each' // it.each(table) alone is the inner half of a chained call, not a case itself — see below
      ) {
        if (callee.name.text === 'todo') todoCases.push(caseRef());
        else cases.push(caseRef()); // .skip, .only, .concurrent, ... all still real written cases
      } else if (
        ts.isCallExpression(callee) &&
        ts.isPropertyAccessExpression(callee.expression) &&
        ts.isIdentifier(callee.expression.expression) &&
        (callee.expression.expression.text === 'it' || callee.expression.expression.text === 'test') &&
        callee.expression.name.text === 'each'
      ) {
        cases.push(caseRef()); // it.each(table)(name, fn) — the tagged-template form, it.each`...`(name, fn), isn't recognized
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { cases, todoCases };
}
