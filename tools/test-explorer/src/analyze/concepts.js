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
import { INFRASTRUCTURE_KEY, INFRASTRUCTURE_LABEL } from '../model.js';

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
