/**
 * The area registry: docs/test-explorer-spec.md §5, amended by §2a.
 *
 * Loads concepts.json and matches source files against each area's glob
 * patterns. A file can legitimately match more than one area's patterns now
 * — testing-strategy.md §9.1 made the outer `describe` an undotted **feature
 * area** ("Capture", "Triage", "Offline") rather than a dotted entity, and a
 * single file like `apps/api/src/domain/items.ts` backs several of those
 * areas as different rules in the same file (`captureItem` for Capture,
 * `applySetStatus`/`applySnoozeUntil` for Triage and Offline). The original
 * "exactly one concept per file" invariant assumed the dotted-entity shape
 * and does not survive that change; see §2a for the full account.
 *
 * A file matching zero registered areas falls into the implicit
 * `infrastructure` bucket, same as before.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INFRASTRUCTURE_KEY, INFRASTRUCTURE_LABEL, LEVEL_IDS } from '../model.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reads the registry from this tool's own package (tools/test-explorer/concepts.json),
 * not from the `--repo` target — it is this tool's own checked-in config, not
 * something looked up inside whatever tree it happens to be pointed at.
 *
 * @returns {{ key: string, label: string, sourcePatterns: string[] }[]}
 */
export function loadConcepts() {
  const file = path.join(here, '../../concepts.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed.concepts;
}

/** Converts one glob pattern (using '*' and '**') into a RegExp anchored to a repo-relative path. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      out += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * @param {{ key: string, sourcePatterns: string[] }[]} concepts
 * @param {string} relPath repo-relative file path
 * @returns {string[]} every area key whose patterns match this file — can be more than one (see module doc)
 */
export function matchingConcepts(concepts, relPath) {
  const hits = [];
  for (const concept of concepts) {
    for (const pattern of concept.sourcePatterns) {
      if (globToRegExp(pattern).test(relPath)) {
        hits.push(concept.key);
        break;
      }
    }
  }
  return hits;
}

/**
 * Resolves every tracked source file to the area(s) it belongs to (or
 * `infrastructure` when it matches none). Multi-membership is expected, not
 * an error — see module doc.
 *
 * @param {{ key: string, sourcePatterns: string[] }[]} concepts
 * @param {string[]} relPaths repo-relative source file paths
 * @returns {Map<string, string[]>} file -> area keys (never empty; ['infrastructure'] when unmatched)
 */
export function resolveFiles(concepts, relPaths) {
  const byFile = new Map();
  for (const relPath of relPaths) {
    const hits = matchingConcepts(concepts, relPath);
    byFile.set(relPath, hits.length ? hits : [INFRASTRUCTURE_KEY]);
  }
  return byFile;
}

export function withInfrastructure(concepts) {
  return [...concepts, { key: INFRASTRUCTURE_KEY, label: INFRASTRUCTURE_LABEL, sourcePatterns: [] }];
}

/**
 * Turns the flat registry into a tree via each entry's optional `parent` key
 * (docs/test-explorer-spec.md, "How the built tool got its current shape" (§2b)) — a real feature area too big for one row
 * (Dashboards: drag-drop, resizing, ...) gets children this way instead of
 * the describe convention itself needing to encode nesting.
 *
 * `makeNode(concept)` builds the per-node payload (counts, rules, etc.) —
 * kept as a callback so this function stays pure tree-shaping and the caller
 * (analyze/index.js) owns what data actually lands on each node.
 *
 * @param {{ key: string, parent?: string }[]} concepts
 * @param {(concept: object) => object} makeNode
 * @returns {{ tree: object[], warnings: string[] }}
 *   tree is the root nodes (no parent, or a parent that doesn't resolve — reported as a warning
 *   rather than dropped, since a typo'd parent must never silently swallow a whole area's rows).
 */
export function buildTree(concepts, makeNode) {
  const warnings = [];
  const byConceptKey = new Map(concepts.map((c) => [c.key, c]));
  const byKey = new Map(concepts.map((c) => [c.key, { ...makeNode(c), children: [] }]));

  /** True when walking `parent` pointers from `key` returns to `key` itself. */
  function inCycle(key) {
    let current = byConceptKey.get(key);
    const seen = new Set();
    while (current?.parent) {
      if (seen.has(current.key)) return true;
      seen.add(current.key);
      current = byConceptKey.get(current.parent);
    }
    return false;
  }

  const roots = [];
  for (const concept of concepts) {
    const node = byKey.get(concept.key);
    if (!concept.parent) {
      roots.push(node);
      continue;
    }
    const parent = byKey.get(concept.parent);
    if (!parent) {
      warnings.push(`"${concept.key}" names "${concept.parent}" as its parent, which is not a registered area; rendered as a root.`);
      roots.push(node);
      continue;
    }
    if (inCycle(concept.key)) {
      warnings.push(`"${concept.key}"'s parent chain cycles back to itself through "${concept.parent}"; rendered as a root.`);
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  return { tree: roots, warnings };
}

/**
 * Gives every node what its whole subtree holds, and where it sits.
 *
 * A row that holds other rows has nothing filed against its own name — no test
 * says `describe('Workspaces')` — so on its own numbers it reads as an
 * untested part of the product on the page whose job is to say what is
 * untested, and collapsing it hides everything underneath. Each row therefore
 * carries both: `counts` stays its own (the Rules tab lists exactly those),
 * and `subtree` is what it plus everything under it holds.
 *
 * Files and branches are counted by identity, not summed. One source file
 * legitimately belongs to several areas ("The area registry" in
 * docs/test-explorer-spec.md), and `Menu.tsx` under both Dashboards and Panels
 * is one file nothing runs, not two — the same reason `summarise` in model.js
 * deduplicates for the masthead.
 *
 * A level that is `null` is n/a rather than zero, so a total ignores the nulls
 * and stays null only when every node in the subtree is n/a: summing "unknown"
 * as zero is what would let the page report a gap that nobody has measured as
 * no gap at all.
 *
 * @param {object[]} tree root nodes, each already carrying counts/rules/gaps
 * @returns {object[]} the same tree, annotated in place
 */
export function annotateTree(tree) {
  for (const root of tree) annotate(root, []);
  return tree;
}

/** Returns every node in this one's subtree, itself included, so its parent can total them. */
function annotate(node, ancestorLabels) {
  node.path = ancestorLabels;
  const below = node.children.flatMap((child) => annotate(child, [...ancestorLabels, node.label]));

  const inSubtree = [node, ...below];
  const counts = {};
  for (const id of LEVEL_IDS) {
    const known = inSubtree.map((n) => n.counts[id]).filter((c) => c !== null);
    counts[id] = known.length ? known.reduce((a, b) => a + b, 0) : null;
  }

  const files = new Set();
  for (const n of inSubtree) for (const f of n.filesNothingRuns) files.add(f.file);

  // Branch gaps are counted once per *file*, not once per file:line. The file
  // is what can belong to two areas beneath this row and must not be counted
  // twice; a line is not, and one line genuinely holds two gaps when an
  // if/else or an `a || b` has both paths uncovered (coverage.js keys an entry
  // by line alone, so those two are indistinguishable by key). Collapsing them
  // would let a row's total print smaller than its own count.
  const measured = inSubtree.filter((n) => n.branchesNothingTakes !== null);
  const gapsPerFile = new Map();
  for (const n of measured) {
    const own = new Map();
    for (const b of n.branchesNothingTakes) own.set(b.file, (own.get(b.file) ?? 0) + 1);
    // The same file's gaps are the same list wherever it appears, so this is a
    // one-per-file record rather than a sum; max only guards a disagreement.
    for (const [file, count] of own) gapsPerFile.set(file, Math.max(gapsPerFile.get(file) ?? 0, count));
  }
  const branchTotal = [...gapsPerFile.values()].reduce((a, b) => a + b, 0);

  node.subtree = { counts, filesNothingRuns: files.size, branchesNothingTakes: measured.length ? branchTotal : null };
  return inSubtree;
}

/**
 * The mechanical check CI runs (§7, amended by §2a): every feature area a
 * test file actually declares (its outer describe) must be a registered
 * area. This replaced the original "every source file matches exactly one
 * area" check, which stopped being a coherent invariant once multi-membership
 * became normal — there was nothing left for it to reject. Anchoring the
 * check to describe names instead keeps the same property the file-overlap
 * check was after: a typo'd or forgotten area name fails the build with a
 * one-line, reviewable fix, rather than silently reading as zero everywhere.
 *
 * @param {{ key: string }[]} concepts
 * @param {string[]} usedAreaNames every outer describe text found across all test files
 * @returns {string[]} area names used in tests but not present in concepts.json
 */
export function unregisteredAreas(concepts, usedAreaNames) {
  const known = new Set(concepts.map((c) => c.key));
  return [...new Set(usedAreaNames)].filter((name) => !known.has(name)).sort();
}
