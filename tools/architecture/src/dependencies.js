/**
 * The Dependencies view as data. Pure: the description file, the areas read
 * off disk and the Modules view in, a matrix out.
 *
 * A cell counts the files of one area that import another area. A relative
 * import is resolved to the file it lands on and so to the area holding that
 * file; a workspace package imported by name lands on that package's area.
 * Imports within one area, and anything a test imports, count for nothing; a
 * file importing an area twice counts once, and a type-only import or a
 * re-export is an import like any other.
 *
 * Direction is the order the areas stand in the description file: an import
 * of a later area is downward, of an earlier one upward. Two areas importing
 * each other are mutual, except where one is declared read by everything.
 */

import path from 'node:path/posix';

import { isCodeFile, isTestFile } from './description.js';
import { importsOf } from './scan.js';

/** The ways a relative import may leave out what the file on disk spells out. */
function candidatesFor(resolved, extensions) {
  const stem = resolved.replace(/\.[cm]?[jt]sx?$/, '');
  return [resolved, ...extensions.map((extension) => `${stem}${extension}`), ...extensions.map((extension) => `${resolved}${extension}`), ...extensions.map((extension) => `${resolved}/index${extension}`)];
}

/** How many lines a file's text holds: a final newline does not start another. */
const linesIn = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/**
 * @param {object} description the parsed description file
 * @param {{ path: string, package: boolean, packageName?: string|null, files: { file: string, text: string|null }[] }[]} candidates every folder discovery found
 * @param {{ layers: { areas: { path: string, state: string }[] }[] }} modules the Modules view, which fixes the areas and their order
 */
export function buildDependencies(description, candidates, modules) {
  const { scan } = description;
  const areas = modules.layers
    .flatMap((layer) => layer.areas)
    .filter((each) => each.state !== 'gone')
    .map((each) => ({
      path: each.path,
      name: each.name,
      muted: description.readByEveryone.includes(each.path),
      lines: 0,
    }));
  const known = new Set(areas.map((each) => each.path));
  const order = new Map(areas.map((each, index) => [each.path, index]));

  const byFile = new Map();
  const byPackage = new Map();
  for (const candidate of candidates) {
    if (!known.has(candidate.path)) continue;
    for (const each of candidate.files) byFile.set(each.file, candidate.path);
    if (candidate.packageName) byPackage.set(candidate.packageName, candidate.path);
  }
  const folders = [...known].filter((each) => !each.endsWith('/*')).sort((a, b) => b.length - a.length);

  const areaOfRelative = (from, specifier) => {
    const resolved = path.join(path.dirname(from), specifier);
    for (const each of candidatesFor(resolved, scan.extensions)) if (byFile.has(each)) return byFile.get(each);
    return folders.find((folder) => resolved === folder || resolved.startsWith(`${folder}/`)) ?? null;
  };
  const areaOfPackage = (specifier) => {
    for (const [name, area] of byPackage) if (specifier === name || specifier.startsWith(`${name}/`)) return area;
    return null;
  };

  const importers = new Map(); // "from\0to" -> the files of `from` that import `to`
  for (const candidate of candidates) {
    if (!known.has(candidate.path)) continue;
    const area = areas.find((each) => each.path === candidate.path);
    for (const { file, text } of candidate.files) {
      if (text === null || !isCodeFile(scan, file) || isTestFile(scan, file)) continue;
      area.lines += linesIn(text);
      for (const specifier of importsOf(text)) {
        const target = specifier.startsWith('.') ? areaOfRelative(file, specifier) : areaOfPackage(specifier);
        if (target === null || target === candidate.path) continue;
        const key = `${candidate.path}\0${target}`;
        importers.set(key, (importers.get(key) ?? new Set()).add(file));
      }
    }
  }

  const mutedPaths = new Set(areas.filter((each) => each.muted).map((each) => each.path));
  const cells = [...importers.entries()].map(([key, files]) => {
    const [from, to] = key.split('\0');
    const mutual = importers.has(`${to}\0${from}`);
    const kind = mutedPaths.has(from) || mutedPaths.has(to) ? 'muted' : mutual ? 'mutual' : order.get(to) > order.get(from) ? 'downward' : 'upward';
    return { from, to, files: files.size, kind };
  });
  cells.sort((a, b) => order.get(a.from) - order.get(b.from) || order.get(a.to) - order.get(b.to));

  const mutualPairs = cells
    .filter((each) => each.kind === 'mutual' && order.get(each.from) < order.get(each.to))
    .map((each) => [each.from, each.to]);

  return { areas, cells, mutualPairs };
}
