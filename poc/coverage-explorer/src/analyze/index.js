/**
 * The analyzer's only public entry point: a repo path in, a Model out.
 *
 * Imports nothing from ../render/. That is the boundary the whole POC is
 * organised around, because the shape of the report is the least settled part
 * of it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { LEVEL_IDS } from '../model.js';
import {
  KIND_OBLIGATIONS,
  LAYER_CONSEQUENCE,
  REACH_THRESHOLD,
  moduleObligation,
} from '../policy/obligations.js';
import { CELL_ANNOTATIONS, EXTRA_NODES, NODE_NOTES } from '../policy/annotations.js';
import * as nodes from './nodes.js';
import { readFile, purity, fanIn } from './signals.js';
import { attribute, capabilities, handlerFor } from './tests.js';

/**
 * @param {string} repo absolute path to the repository root
 * @returns {import('../model.js').Model}
 */
export function analyze(repo) {
  const warnings = [];
  const packages = nodes.workspacePackages(repo);

  // ---- read every source file once -------------------------------------
  /** @type {Map<string, ReturnType<typeof readFile>>} */
  const files = new Map();
  /** @type {string[]} */
  const testFiles = [];
  /** @type {Map<string, string>} package specifier -> entry file */
  const packageEntries = new Map();
  /** @type {Map<string, {rel: string, layers: Map<string,string[]>, loose: string[], meta: object}>} */
  const scanned = new Map();

  for (const rel of packages) {
    const scan = nodes.scanPackage(repo, rel);
    const meta = nodes.classifyPackage(repo, rel);
    scanned.set(rel, { rel, ...scan, meta });

    const name = nodes.packageName(repo, rel);
    const entry = nodes.packageEntry(repo, rel);
    if (name && entry) packageEntries.set(name, entry);

    for (const relFile of [...scan.loose, ...[...scan.layers.values()].flat()]) {
      const abs = path.join(repo, relFile);
      files.set(abs, readFile(abs));
    }
    for (const relTest of scan.tests) testFiles.push(path.join(repo, relTest));
  }

  const fan = fanIn(files, packageEntries);
  const coverage = attribute(testFiles, files, packageEntries);

  // ---- build the tree ---------------------------------------------------
  /** @type {import('../model.js').Node} */
  const root = {
    id: 'root',
    name: 'cockpit',
    path: '.',
    kind: 'repo',
    note: 'The composition root. System and end-to-end levels attach here, because nothing below owns a whole capability.',
    own: obligationsForKind('repo'),
    children: [],
  };

  for (const rel of packages) {
    if (rel.startsWith('packages/connectors/')) continue; // handled by its own parent below
    const pkg = scanned.get(rel);
    const node = {
      id: rel,
      name: rel,
      path: rel,
      kind: pkg.meta.kind,
      note: NODE_NOTES[rel],
      own: obligationsForKind(pkg.meta.obligationKey),
      children: [],
    };

    for (const [layer, layerFiles] of [...pkg.layers].sort((a, b) => a[0].localeCompare(b[0]))) {
      const layerPath = path.posix.join(rel, 'src', layer);
      node.children.push({
        id: layerPath,
        name: `${layer}/`,
        path: layerPath,
        kind: 'layer',
        note: NODE_NOTES[layerPath],
        own: {},
        children: layerFiles.map((f) => moduleNode(repo, f, layer, pkg.meta.frontend, files, fan, coverage)),
      });
    }
    for (const f of pkg.loose) {
      node.children.push(moduleNode(repo, f, 'root', pkg.meta.frontend, files, fan, coverage));
    }

    root.children.push(node);
  }

  // ---- nodes that cannot be derived ------------------------------------
  for (const extra of EXTRA_NODES) {
    if (extra.parent !== 'root') {
      warnings.push(`EXTRA_NODES entry ${extra.id} names an unknown parent ${extra.parent}; attached to root.`);
    }
    root.children.push(materialise(extra));
  }

  // ---- capabilities -----------------------------------------------------
  const commandsPath = path.join(repo, 'packages/shared/src/commands.ts');
  let caps = [];
  if (existsSync(commandsPath)) {
    const src = readFileSync(commandsPath, 'utf8');
    const domainAbs = path.join(repo, 'apps/api/src/domain/items.ts');
    const reached = coverage.get(domainAbs)?.reached ?? new Set();
    const schemaReached = coverage.get(path.join(repo, 'packages/shared/src/commands.ts'))?.reached ?? new Set();
    caps = capabilities(src).map((name) => {
      const handler = handlerFor(name);
      return {
        name,
        handler,
        cells: {
          L1: reached.has(handler) ? 'ok' : 'gap',
          schema: [...schemaReached].some((s) => s.toLowerCase().startsWith(camel(name).toLowerCase())) ? 'ok' : 'gap',
          F2: 'gap',
          F3: 'gap',
        },
      };
    });
  } else {
    warnings.push('packages/shared/src/commands.ts not found; the capability axis is empty.');
  }

  if (!testFiles.length) warnings.push('No TypeScript test files found. Every unit cell will read as absent.');

  return {
    commit: commitSha(repo),
    generatedAt: new Date().toISOString(),
    root,
    capabilities: caps,
    warnings,
  };
}

// ---------------------------------------------------------------- helpers

function camel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function obligationsForKind(key) {
  const table = key ? KIND_OBLIGATIONS[key] : null;
  if (!table) return {};
  /** @type {Record<string, import('../model.js').Cell>} */
  const own = {};
  for (const [level, spec] of Object.entries(table)) {
    own[level] = {
      state: spec.require === 'required' ? 'gap' : 'later',
      count: 0,
      why: spec.why,
      source: 'derived',
    };
  }
  return own;
}

/**
 * One module node, with its signals, its obligation and the state that follows
 * from comparing the two.
 */
function moduleNode(repo, relFile, layer, frontend, files, fan, coverage) {
  const abs = path.join(repo, relFile);
  const parsed = files.get(abs);
  const { pure, reason } = purity(parsed);

  /** @type {import('../model.js').Signals} */
  const signals = {
    branches: parsed.branches,
    pure,
    impureReason: reason,
    fanIn: fan.get(abs) ?? 0,
    consequence: LAYER_CONSEQUENCE[layer] ?? 'wrong',
    exports: parsed.exports,
    reached: [...(coverage.get(abs)?.reached ?? [])],
  };

  const node = {
    id: relFile,
    name: path.basename(relFile),
    path: relFile,
    kind: 'module',
    lines: parsed.lines,
    note: NODE_NOTES[relFile],
    signals,
    own: {},
    children: [],
  };

  const hits = coverage.get(abs);
  let obligation = moduleObligation(signals, { frontend });

  // Measurement outranks the model. A module with tests must never render as
  // "no obligation": the tests are a fact, and hiding them would make the page
  // wrong about the repository. This is how packages/shared/ids.ts and
  // commands.ts stay visible, since both are branchless (bit twiddling and Zod
  // schema declarations) and the rule alone would say nothing about them.
  if (!obligation && hits?.tests) {
    obligation = {
      level: frontend ? 'F1' : 'L1',
      require: 'later',
      why: 'No branches, so the rule obligates nothing here, but tests exist and are reported as found.',
    };
  }

  if (obligation) {
    const level = obligation.level;
    const tests = hits?.tests ?? 0;
    let state;
    let why = obligation.why;

    if (!tests) {
      state = obligation.require === 'required' ? 'gap' : 'later';
    } else {
      const total = signals.exports.length || 1;
      const ratio = signals.reached.length / total;
      state = ratio >= REACH_THRESHOLD ? 'ok' : 'thin';
      if (state === 'thin') {
        const missing = signals.exports.filter((e) => !signals.reached.includes(e));
        why =
          `${tests} test(s), but only ${signals.reached.length} of ${total} exports are reached. ` +
          `Untouched: ${missing.join(', ')}.`;
      } else {
        why = `${tests} test(s) reaching ${signals.reached.length} of ${total} exports.`;
      }
    }
    node.own[level] = { state, count: tests, why, source: 'derived' };
  }

  applyAnnotations(node);
  return node;
}

/** Human overrides, marked so the render can distinguish them from measurement. */
function applyAnnotations(node) {
  const overrides = CELL_ANNOTATIONS[node.path];
  if (!overrides) return;
  for (const [level, spec] of Object.entries(overrides)) {
    if (!LEVEL_IDS.includes(level)) continue;
    node.own[level] = {
      state: spec.state,
      count: spec.count ?? node.own[level]?.count ?? 0,
      why: spec.why,
      source: 'annotated',
    };
  }
}

/** Turns an EXTRA_NODES entry into a real node, recursively. */
function materialise(spec) {
  const kindTable = spec.kind === 'connector' ? KIND_OBLIGATIONS.connector : null;
  const own = {};
  if (kindTable) {
    for (const [level, o] of Object.entries(kindTable)) {
      own[level] = { state: o.require === 'required' ? 'gap' : 'later', count: 0, why: o.why, source: 'derived' };
    }
  }
  for (const [level, cell] of Object.entries(spec.own ?? {})) {
    own[level] = { ...cell, count: cell.count ?? 0, source: 'annotated' };
  }
  return {
    id: spec.id,
    name: spec.name,
    path: spec.path,
    kind: spec.kind,
    note: spec.note,
    projected: spec.projected,
    own,
    children: (spec.children ?? []).map(materialise),
  };
}

function commitSha(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
