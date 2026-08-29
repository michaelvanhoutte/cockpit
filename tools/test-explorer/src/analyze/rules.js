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
  // backend-shaped code with no frontend equivalent. packages/connectors/<name>/
  // needs its own alternative here (not just packages/[^/]+) because a connector
  // package nests one level deeper than packages/shared does.
  m = relPath.match(/^(?:apps\/api|packages\/(?:connectors\/)?[^/]+)\/tests\/([^/]+)\//);
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
 * The dotted callee of a call, when it is a plain identifier chain:
 * `describe` -> ['describe'], `test.describe.serial` -> ['test', 'describe', 'serial'].
 * Returns null for anything else — a computed access, or a chain with a call in the
 * middle such as `it.each(table)(...)`, which has its own handling in collectCases.
 */
function calleeChain(callee) {
  const parts = [];
  let node = callee;
  while (ts.isPropertyAccessExpression(node)) {
    parts.unshift(node.name.text);
    node = node.expression;
  }
  if (!ts.isIdentifier(node)) return null;
  parts.unshift(node.text);
  return parts;
}

/**
 * Recognizes `describe(...)` and the modifier forms `describe.skip/.only/.concurrent/.sequential(...)`
 * — mirroring countCases below, which already treats `it.skip`/`.only` as real, counted cases. Without
 * this, a temporarily-skipped top-level describe silently drops its whole feature area's rules with no
 * warning, inconsistent with how a skipped case is handled.
 *
 * Also `test.describe(...)` and `test.describe.serial/.parallel/.skip/.only(...)`: Playwright, the F3
 * runner, exposes describe as a member of `test` rather than as a free function, so an e2e file writes
 * the same two-level structure through a different spelling. Before this it matched nothing here and,
 * worse, `collectCases` counted each `test.describe` as a *case* — an F3 file would have reported its
 * feature areas as absent and its rule statements as case labels.
 *
 * @returns {{ text: string, body: ts.Node, node: ts.CallExpression } | null}
 */
function describeCall(stmt) {
  if (!ts.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!ts.isCallExpression(expr)) return null;
  const chain = calleeChain(expr.expression);
  if (!chain) return null;
  const [root, second] = chain;
  const isDescribe =
    root === 'describe' || ((root === 'test' || root === 'it') && second === 'describe');
  if (!isDescribe) return null;
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
/**
 * Members of `test`/`it` that are not cases, however much they look like one. `describe` is the
 * consequential one — Playwright spells a rule `test.describe(...)`, and counting that as a case
 * would put every rule statement in the case column and leave the rule column empty. The hooks and
 * configuration members are the same mistake in a quieter form: `test.beforeEach(async () => ...)`
 * has no title at all, so it would have been reported as a case whose label is the source text of
 * its own callback.
 */
const NOT_A_CASE = new Set([
  'each', // it.each(table) alone is the inner half of a chained call — see below
  'describe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'step',
  'use',
  'slow',
  'setTimeout',
  'extend',
  'info',
  'expect',
]);
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
        !NOT_A_CASE.has(callee.name.text)
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
        // it.each(table)(name, fn) — the tagged-template form, it.each`...`(name, fn), isn't recognized.
        // The whole point of .each is a table row per case; resolving it (rather than showing the raw
        // template once) is what makes a case like '$situation' readable — see resolveEachCases below.
        cases.push(...resolveEachCases(callee.arguments[0], caseText(nameArg, source), relFile, lineOf(source, n)));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { cases, todoCases };
}

/**
 * Turns `it.each(table)(template, fn)` into one real case per row, `template`'s own `$key`/`%s`-style
 * placeholders substituted with that row's actual value where it's statically known — this is what
 * makes a case display as "without a request id" rather than the raw template text "$situation"
 * (docs/test-explorer-spec.md §2f). Every element of `table` becomes one case regardless of whether
 * its own values are literal — the row *count* is always known once `table` is a real array literal;
 * only the substitution degrades (an unresolvable property is left as its literal `$key` token) when a
 * value can't be. If `table` isn't an array literal at all (built from a variable, a function call, a
 * spread, ...), nothing about it — not even the count — can be known statically, and this falls back to
 * one case using the raw template text, same as before this existed.
 */
function resolveEachCases(table, template, relFile, line) {
  if (!table || !ts.isArrayLiteralExpression(table)) {
    return [{ text: template, file: relFile, line }];
  }
  return table.elements.map((rowNode, index) => ({
    text: substituteTemplate(template, evalRow(rowNode), index),
    file: relFile,
    line,
  }));
}

/** A table row: a shallow best-effort object (unresolvable properties simply absent) or a plain literal value. */
function evalRow(node) {
  return ts.isObjectLiteralExpression(node) ? evalObjectShallow(node) : evalLiteral(node);
}

/**
 * Never fails, unlike `evalLiteral`: a property whose value can't be statically resolved (a call, an
 * identifier, a spread, ...) is simply left out of the result rather than failing the whole object —
 * this is what lets `{ situation: 'literal', capture: { itemId: uuidv7() } }` still resolve `situation`
 * even though `capture` can't be resolved at all (the real case that prompted this: commands.test.ts).
 */
function evalObjectShallow(node) {
  const out = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue; // shorthand, spread, method: silently unresolved
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
    if (key === undefined) continue;
    const value = evalLiteral(prop.initializer);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A strict literal evaluator: returns `undefined` (bail) the moment anything isn't statically known. */
function evalLiteral(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isParenthesizedExpression(node)) return evalLiteral(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = evalLiteral(node.operand);
    return typeof inner === 'number' ? -inner : undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const el of node.elements) {
      if (ts.isSpreadElement(el)) return undefined;
      const v = evalLiteral(el);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) return evalObjectShallow(node);
  return undefined; // an identifier, a call, a template with substitutions, ... — not resolvable
}

/**
 * Substitutes a `.each` template's placeholders with a row's actual value: `$key`/`$a.b` (vitest's
 * property-path form, against an object row) and `%s`/`%d`/`%i`/`%f`/`%j`/`%o`/`%#`/`%%` (printf-style,
 * positional against an array row, or the row itself for a scalar row). A placeholder with nothing to
 * resolve it — the row wasn't an object, or that particular key/position wasn't statically known — is
 * left exactly as written, so a partly-resolved template never looks like a wrong value.
 */
function substituteTemplate(template, row, index) {
  let out = template.replace(/\$([a-zA-Z_][a-zA-Z0-9_.]*)/g, (token, path) => {
    if (row === null || typeof row !== 'object') return token;
    let value = row;
    for (const segment of path.split('.')) {
      if (value == null || typeof value !== 'object') return token;
      value = value[segment];
    }
    return value === undefined ? token : stringifyRowValue(value);
  });

  if (/%[sdifjo#%]/.test(out)) {
    const positional = Array.isArray(row) ? row : [row];
    let cursor = 0;
    out = out.replace(/%[sdifjo%#]/g, (token) => {
      if (token === '%%') return '%';
      if (token === '%#') return String(index);
      const value = positional[cursor++];
      if (value === undefined) return token;
      return token === '%j' || token === '%o' ? JSON.stringify(value) : stringifyRowValue(value);
    });
  }

  return out;
}

function stringifyRowValue(value) {
  return typeof value === 'string' ? value : String(value);
}
