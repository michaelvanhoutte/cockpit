/**
 * The actuals: which tests exist, and what they reach.
 *
 * No instrumentation and no coverage run. A test file's imports say which
 * modules it exercises and which of their exports it touches, which is enough
 * to separate "tested" from "partially tested" without ever executing anything.
 * That is deliberate: a report that needs the suite to run is a report that
 * stops working the moment the suite breaks.
 */

import ts from 'typescript';
import { parse, resolve } from './signals.js';

/**
 * Reads one test file and returns the modules it imports, with the named
 * exports it took from each.
 *
 * @param {string} file absolute path
 * @param {Map<string, unknown>} files all known source files
 * @param {Map<string, string>} packageEntries
 */
export function readTestFile(file, files, packageEntries) {
  const { source } = parse(file);

  /** @type {Map<string, Set<string>>} target absolute path -> imported names */
  const targets = new Map();
  let tests = 0;
  let assertions = 0;

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // `import type` does not exercise anything at runtime.
      if (!node.importClause?.isTypeOnly) {
        const target = resolve(node.moduleSpecifier.text, file, files, packageEntries);
        if (target) {
          if (!targets.has(target)) targets.set(target, new Set());
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              if (!el.isTypeOnly) targets.get(target).add(el.name.text);
            }
          }
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'it' || name === 'test') tests++;
      if (name === 'expect') assertions++;
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return { targets, tests, assertions };
}

/**
 * Attributes each test file's tests to the modules it imports.
 *
 * A test file that imports two modules attributes its count to both rather than
 * splitting it. The number is a signal of attention, not a budget, and halving
 * it would imply a precision that is not there.
 *
 * @returns {Map<string, { tests: number, assertions: number, reached: Set<string>, files: string[] }>}
 */
export function attribute(testFiles, files, packageEntries) {
  /** @type {Map<string, { tests: number, assertions: number, reached: Set<string>, files: string[] }>} */
  const byModule = new Map();

  for (const testFile of testFiles) {
    const { targets, tests, assertions } = readTestFile(testFile, files, packageEntries);
    for (const [target, names] of targets) {
      if (!byModule.has(target)) {
        byModule.set(target, { tests: 0, assertions: 0, reached: new Set(), files: [] });
      }
      const entry = byModule.get(target);
      entry.tests += tests;
      entry.assertions += assertions;
      entry.files.push(testFile);
      for (const n of names) entry.reached.add(n);
    }
  }
  return byModule;
}

/**
 * Source 4 of the node derivation: the capability axis.
 *
 * Read straight out of the command registry, so it cannot fall behind the code.
 * A capability's unit coverage is whichever domain handler backs it; its
 * frontend coverage is whatever the frontend suite proves, which today is
 * nothing.
 *
 * @param {string} commandsSource contents of packages/shared/src/commands.ts
 */
export function capabilities(commandsSource, registryName = 'commandSchemas') {
  const source = ts.createSourceFile('commands.ts', commandsSource, ts.ScriptTarget.Latest, true);
  const names = [];

  // Anchored on the registry declaration by name. An earlier version collected
  // every snake_case key in the file, which swept up field names from the
  // individual schemas (title, status, horizon) and reported them as
  // capabilities. The registry is one specific object; find that one.
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === registryName &&
      node.initializer
    ) {
      const literal = unwrap(node.initializer);
      if (literal && ts.isObjectLiteralExpression(literal)) {
        for (const prop of literal.properties) {
          if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
            const key = prop.name;
            if (ts.isIdentifier(key) || ts.isStringLiteral(key)) names.push(key.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return names;
}

/** Strips `as const` and parentheses from around an expression. */
function unwrap(expr) {
  let e = expr;
  while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
  return e;
}

/** Domain handler conventionally backing a command name. */
export function handlerFor(command) {
  if (command === 'capture_item') return 'captureItem';
  if (command === 'associate') return 'associationFromCommand';
  return 'apply' + command.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}
