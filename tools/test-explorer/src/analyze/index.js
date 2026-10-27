/**
 * The analyzer's only public entry point: a repo path in, a Model out.
 * Knows nothing about how its model is drawn.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { LEVEL_IDS } from '../model.js';
import { annotateTree, buildTree, loadConcepts, loadNotWorthATest, NOT_WORTH_A_TEST, resolveFiles, unregisteredAreas, withInfrastructure } from './concepts.js';
import { extractRules, levelForTestFile } from './rules.js';
import { parseFile } from './ast.js';
import { workspacePackages, sourceFiles, testFiles } from './workspace.js';
import { loadMergedCoverage, branchesNotTaken, statementsCovered } from './coverage.js';

/**
 * @param {string} repo absolute path to the repository root
 * @param {{ notWorthATest?: string }} [options] where the list of files judged not worth a test is read from: this tool's own, beside concepts.json, unless given
 * @returns {import('../model.js').Model}
 */
export function analyze(repo, { notWorthATest = NOT_WORTH_A_TEST } = {}) {
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
  /** @type {string[]} repo-relative */
  const relSourceFiles = [];
  for (const rel of packages) relSourceFiles.push(...sourceFiles(repo, rel));

  // A file can legitimately belong to more than one feature area now (see
  // concepts.js's module doc) — resolveFiles returns every matching area key
  // per file, not a single one, and that is not an error to warn about.
  const fileConcepts = resolveFiles(registry, relSourceFiles);

  // ---- test files: rules -------------------------------------------------
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
  /** @type {string[]} every top-level describe text seen across all test files, used or not */
  const allAreasSeen = [];

  const contextCache = new Map();

  for (const t of allTestFiles) {
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

  // ---- the files judged not worth a test, each held to a file walked here ----
  const decisions = loadNotWorthATest(notWorthATest, new Set(relSourceFiles));

  // ---- merged coverage: statements run and branches taken ----------------
  const coverage = loadMergedCoverage(repo, packages);
  warnings.push(...coverage.warnings);
  // Files whose own package emitted no coverage-final.json at all (no test:coverage script, e.g.
  // packages/connector-sdk today) or that every package's coverage config excludes (`**/index.ts`)
  // — branchesNotTaken(...) and statementsCovered(...) return null for these, not an empty figure,
  // so they must not silently count as "0 branches nothing takes" or "0 statements run" when what's
  // actually true is "never measured". Collected while building the tree below, reported once here.
  const uninstrumentedFiles = new Set();

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
      } else {
        const count = rules.filter((r) => r.level === id).length;
        // Contract is a scheduled tier few areas have a suite in: n/a (not 0) for one no contract suite names.
        counts[id] = id === 'Contract' && count === 0 ? null : count;
      }
    }

    const files = filesByConcept.get(concept.key) ?? [];

    const branchesNothingTakes = coverage.available
      ? files.flatMap((relFile) => {
          const notTaken = branchesNotTaken(coverage.map, path.join(repo, relFile));
          if (notTaken === null) {
            uninstrumentedFiles.add(relFile);
            return [];
          }
          return notTaken.map((b) => withContext({ file: relFile, line: b.line }, repo, contextCache));
        })
      : null;

    // Each own file's statements, how many ran and the lines none ran; a file coverage never
    // measured has no figure (it is named in the warning below), and the area has none at all
    // when the run had no coverage.
    const statements = coverage.available
      ? [...files].sort().flatMap((relFile) => {
          const s = statementsCovered(coverage.map, path.join(repo, relFile));
          return s === null ? [] : [{ file: relFile, ...s }];
        })
      : null;

    return { key: concept.key, label: concept.label, counts, rules, branchesNothingTakes, statements };
  }

  const { tree, warnings: treeWarnings } = buildTree(withInfra, makeNode);
  annotateTree(tree);
  warnings.push(...treeWarnings);

  if (uninstrumentedFiles.size) {
    warnings.push(
      '"Branches nothing takes" and the share covered have no coverage data for the following file(s) — excluded by a package\'s ' +
        'coverage config, or owned by a package with no test:coverage script — so their branches read as a clean 0 ' +
        `rather than unknown and their statements are left out of the share; treat a figure on a concept that owns one of these as unverified: ${[...uninstrumentedFiles].sort().join(', ')}.`,
    );
  }

  return {
    commit: commitSha(repo),
    commitUrl: commitUrl(repo),
    generatedAt: new Date().toISOString(),
    tree,
    coverageAvailable: coverage.available,
    availableLevels,
    unregisteredAreas: unregistered,
    notWorthATest: decisions.decided,
    notWorthATestProblems: decisions.problems,
    warnings,
  };
}

/** A wrangler config marks a package as a deployable Worker/service, the discriminator used for L3 availability. */
function isBackendService(repo, rel) {
  return ['wrangler.jsonc', 'wrangler.toml', 'wrangler.json'].some((f) => existsSync(path.join(repo, rel, f)));
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
