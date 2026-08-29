/**
 * The analyzer's only public entry point: a repo path in, a Model out.
 * Imports nothing from ../render/ (docs/test-explorer-spec.md §6.1).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { LEVEL_IDS } from '../model.js';
import { buildTree, loadConcepts, resolveFiles, unregisteredAreas, withInfrastructure } from './concepts.js';
import { extractRules, levelForTestFile } from './rules.js';
import { parseFile, resolveImport } from './ast.js';
import { workspacePackages, packageName, packageEntry, sourceFiles, testFiles } from './workspace.js';
import { loadMergedCoverage, branchesNotTaken } from './coverage.js';

/**
 * @param {string} repo absolute path to the repository root
 * @returns {import('../model.js').Model}
 */
export function analyze(repo) {
  const warnings = [];
  const packages = workspacePackages(repo);
  const registry = loadConcepts();

  // L3 (system) only means anything once a second backend service exists to
  // wire together at the API level (testing-strategy.md §2: "L2 and L3
  // largely collapse into each other" with one service) — derived from real
  // workspace data (a wrangler config marks a deployable Worker/service),
  // not hardcoded, so it flips on its own the day a second one lands.
  const backendServiceCount = packages.filter((rel) => isBackendService(repo, rel)).length;
  const availableLevels = Object.fromEntries(LEVEL_IDS.map((id) => [id, id !== 'L3' || backendServiceCount > 1]));

  // ---- source files, for the two coverage columns -----------------------
  /** @type {Set<string>} absolute paths */
  const sourceFileSet = new Set();
  /** @type {string[]} repo-relative */
  const relSourceFiles = [];
  /** @type {Map<string, string>} package name -> absolute entry file */
  const packageEntries = new Map();

  for (const rel of packages) {
    const name = packageName(repo, rel);
    const entry = packageEntry(repo, rel);
    if (name && entry) packageEntries.set(name, entry);
    for (const relFile of sourceFiles(repo, rel)) {
      sourceFileSet.add(path.join(repo, relFile));
      relSourceFiles.push(relFile);
    }
  }

  // A file can legitimately belong to more than one feature area now (see
  // concepts.js's module doc) — resolveFiles returns every matching area key
  // per file, not a single one, and that is not an error to warn about.
  const fileConcepts = resolveFiles(registry, relSourceFiles);

  // ---- test files: rules + import reach ----------------------------------
  /** @type {{ absFile: string, relFile: string, level: string }[]} */
  const allTestFiles = [];
  for (const rel of packages) {
    for (const t of testFiles(repo, rel)) {
      const level = levelForTestFile(t.file);
      if (!level) {
        warnings.push(`${t.file}: does not match a known tests/<level>/ shape; skipped.`);
        continue;
      }
      allTestFiles.push({ absFile: path.join(repo, t.file), relFile: t.file, level });
    }
  }
  const e2eDir = path.join(repo, 'tests/e2e');
  if (existsSync(e2eDir)) {
    for (const relFile of walkTestFiles(repo, 'tests/e2e')) {
      allTestFiles.push({ absFile: path.join(repo, relFile), relFile, level: 'F3' });
    }
  }

  if (allTestFiles.length === 0) {
    warnings.push('No test files found under any tests/<level>/ folder. Every row will read as zero.');
  }

  /** @type {Map<string, import('../model.js').Rule[]>} concept key -> rules */
  const rulesByConcept = new Map();
  /** @type {Set<string>} absolute source file paths reached by some test file's imports */
  const reached = new Set();
  /** @type {string[]} every top-level describe text seen across all test files, used or not */
  const allAreasSeen = [];
  /** @type {string[]} repo-relative test files that drive the real Worker over HTTP */
  const httpDrivenTestFiles = [];

  const contextCache = new Map();

  for (const t of allTestFiles) {
    // Parsed once per test file and shared across the three passes below —
    // each used to call parseFile independently, tripling the read+parse
    // cost of the tool's dominant expense for no benefit.
    const { source } = parseFile(t.absFile);

    const { rules, areasSeen, warnings: fileWarnings } = extractRules(source, t.relFile, t.level);
    warnings.push(...fileWarnings);
    allAreasSeen.push(...areasSeen);
    for (const r of rules) {
      if (!registry.some((c) => c.key === r.concept)) {
        warnings.push(`${r.file}:${r.line}: feature area "${r.concept}" is not in concepts.json; add it or fix the typo.`);
        continue;
      }
      if (!rulesByConcept.has(r.concept)) rulesByConcept.set(r.concept, []);
      rulesByConcept.get(r.concept).push(withRuleContext(r, repo, contextCache));
    }

    if (importsSelfFetch(source)) httpDrivenTestFiles.push(t.relFile);
    markReached(source, t.absFile, sourceFileSet, packageEntries, reached);
  }

  // §7/§2a: every feature area a describe actually names must be registered,
  // whether or not it has cases yet — an area with no cases written is still
  // a real area a typo could hide inside, and using `rules` here (which
  // extractRules never produces for an empty describe) would miss exactly
  // that case. `allAreasSeen` carries every top-level describe text found,
  // unfiltered by whether it went on to produce a rule.
  const unregistered = unregisteredAreas(registry, allAreasSeen);
  for (const name of unregistered) {
    warnings.push(`feature area "${name}" is used in a describe but is not in concepts.json; add it or fix the typo.`);
  }

  // "Files nothing runs" is import-reach only (§6.3 of the spec): a test that
  // drives the real Worker over HTTP (`SELF.fetch` from `cloudflare:test`,
  // per testing-strategy's "enter through the real interface, not around it")
  // genuinely exercises the whole request pipeline — routing, the command
  // service, the repo — without ever importing those files directly. This
  // column cannot see that, so it will misreport exactly those files as
  // untested. Named by file rather than a generic example, so the warning
  // stays accurate as more HTTP-driven tests are added.
  if (httpDrivenTestFiles.length) {
    warnings.push(
      '"Files nothing runs" only sees direct imports. The following test(s) drive the real Worker over ' +
        'HTTP (SELF.fetch) rather than importing their targets directly, so files they genuinely exercise ' +
        'through routing can still show up in that column as a false positive — verify against the test ' +
        `file before treating a hit there as a real gap: ${httpDrivenTestFiles.join(', ')}.`,
    );
  }

  // ---- merged branch coverage --------------------------------------------
  const coverage = loadMergedCoverage(repo, packages);
  warnings.push(...coverage.warnings);

  // ---- assemble the tree ---------------------------------------------------
  const filesByConcept = new Map();
  for (const [file, keys] of fileConcepts) {
    for (const key of keys) {
      if (!filesByConcept.has(key)) filesByConcept.set(key, []);
      filesByConcept.get(key).push(file);
    }
  }

  const withInfra = withInfrastructure(registry);

  function makeNode(concept) {
    const rules = rulesByConcept.get(concept.key) ?? [];
    const counts = {};
    for (const id of LEVEL_IDS) {
      if (!availableLevels[id]) {
        counts[id] = null;
      } else if (id === 'Contract' && !hasConnector(concept, packages)) {
        counts[id] = null;
      } else {
        counts[id] = rules.filter((r) => r.level === id).length;
      }
    }

    const files = filesByConcept.get(concept.key) ?? [];
    const filesNothingRuns = files
      .filter((relFile) => !reached.has(path.join(repo, relFile)))
      .sort()
      .map((relFile) => withContext({ file: relFile, line: 1 }, repo, contextCache));

    const branchesNothingTakes = coverage.available
      ? files.flatMap((relFile) =>
          branchesNotTaken(coverage.map, path.join(repo, relFile)).map((b) =>
            withContext({ file: relFile, line: b.line }, repo, contextCache),
          ),
        )
      : null;

    return { key: concept.key, label: concept.label, counts, rules, filesNothingRuns, branchesNothingTakes };
  }

  const { tree, warnings: treeWarnings } = buildTree(withInfra, makeNode);
  warnings.push(...treeWarnings);

  return {
    commit: commitSha(repo),
    commitUrl: commitUrl(repo),
    generatedAt: new Date().toISOString(),
    tree,
    coverageAvailable: coverage.available,
    availableLevels,
    unregisteredAreas: unregistered,
    warnings,
  };
}

/** A wrangler config marks a package as a deployable Worker/service, the discriminator used for L3 availability. */
function isBackendService(repo, rel) {
  return ['wrangler.jsonc', 'wrangler.toml', 'wrangler.json'].some((f) => existsSync(path.join(repo, rel, f)));
}

/**
 * No connector packages exist yet, so this is `false` for every concept today
 * regardless of registry content — but derived from real workspace data
 * (`packages`, already walked via pnpm-workspace.yaml's globs, which include
 * `packages/connectors/*`) rather than hardcoded, so a concept whose registry
 * entry names a real connector package picks it up automatically once one
 * exists, with no code change required here.
 *
 * @param {{ connectors?: string[] }} concept
 * @param {string[]} packages repo-relative workspace package directories
 */
function hasConnector(concept, packages) {
  const names = concept.connectors ?? [];
  return names.some((name) => packages.includes(`packages/connectors/${name}`));
}

/** True when a test file imports `cloudflare:test`'s `SELF` — the marker for an HTTP-driven integration test. */
function importsSelfFetch(source) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'cloudflare:test' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const el of node.importClause.namedBindings.elements) {
        if (el.name.text === 'SELF') found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/**
 * Marks every module a test file's real (non-type-only) imports resolve to as reached. Checks both the
 * whole-declaration flag (`import type {...}`) and each specifier's own flag (`import { type X }`) —
 * a declaration can carry only inline-type specifiers and still have `importClause.isTypeOnly === false`,
 * so checking only the declaration flag would wrongly mark a type-only-in-practice import as reached.
 */
function markReached(source, testFileAbs, sourceFileSet, packageEntries, reached) {
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const bindings = node.importClause?.namedBindings;
      const hasRealSpecifier =
        !bindings || !ts.isNamedImports(bindings) || bindings.elements.some((el) => !el.isTypeOnly);
      if (hasRealSpecifier) {
        const target = resolveImport(node.moduleSpecifier.text, testFileAbs, sourceFileSet, packageEntries);
        if (target) reached.add(target);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

/** Lines of context shown around a referenced line — enough to read a rule/case/gap without opening the file. */
const CONTEXT_RADIUS = 4;
/** A pathological single line (e.g. minified output) is truncated rather than dumped whole. */
const MAX_LINE_LENGTH = 300;

/** @returns {import('../model.js').CodeRef} `ref` (a `{file, line}`) with `context` attached. */
function withContext(ref, repo, cache) {
  return { ...ref, context: contextAt(repo, ref.file, ref.line, cache) };
}

/** A Rule (and each of its cases/todoCases) with `context` attached to all of them. */
function withRuleContext(rule, repo, cache) {
  return {
    ...withContext(rule, repo, cache),
    cases: rule.cases.map((c) => withContext(c, repo, cache)),
    todoCases: rule.todoCases.map((c) => withContext(c, repo, cache)),
  };
}

/** @returns {import('../model.js').ContextLine[]} */
function contextAt(repo, relFile, line, cache) {
  const abs = path.join(repo, relFile);
  if (!cache.has(abs)) {
    try {
      cache.set(abs, readFileSync(abs, 'utf8').split('\n'));
    } catch {
      cache.set(abs, null);
    }
  }
  const lines = cache.get(abs);
  if (!lines) return [];

  const start = Math.max(1, line - CONTEXT_RADIUS);
  const end = Math.min(lines.length, line + CONTEXT_RADIUS);
  const out = [];
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1] ?? '';
    out.push({ line: n, text: text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text });
  }
  return out;
}

function walkTestFiles(repo, relDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (/\.test\.(ts|tsx)$/.test(entry.name)) out.push(rel);
    }
  };
  walk(relDir);
  return out;
}

function commitSha(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/** Link to the commit on GitHub, derived from the `origin` remote — null when it isn't GitHub or can't be read. */
function commitUrl(repo) {
  try {
    const remote = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Handles both https://github.com/owner/repo.git and git@github.com:owner/repo.git.
    const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (!m) return null;
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `https://github.com/${m[1]}/${m[2]}/commit/${sha}`;
  } catch {
    return null;
  }
}
