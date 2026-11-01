/**
 * The Logical view as data. Pure: the design (description.js), the areas read off disk and the code of the
 * callers in, the design laid against the code out.
 *
 * Evidence comes first. Every source file is placed in the component whose folders hold it; each import
 * (resolved the way the Dependencies view resolves one) and each marker match is one piece of evidence with
 * its file and line, a file counted once for each thing it imports or reaches. A line that only a comment
 * holds is not evidence. The comparison then judges each pair of components against the design:
 *
 *   same layer                      counted on the layer, never drawn and never wrong
 *   a pair of layers the design allows   one line per pair of layers, with its files
 *   any other pair                  a numbered deviation, chip to chip, unless the design accepts it with a reason
 *                                   for every file that makes it (a file it does not name stays red, as new)
 *   a pair of layers the design allows that no file uses   in the design, not in the code
 *
 * Placement is checked here too: every folder the code has is in exactly one component, or is listed as
 * drawn as no line, and every folder a component names is on disk. The result is recorded, not thrown: the
 * architecture tool's test is what fails on it.
 */

import path from 'node:path';

import { importResolver } from './dependencies.js';
import { codeOf, importsOf } from './scan.js';

/** The lines of a file with every comment blanked out (so a match on one is not evidence), with their line numbers. */
const codeLines = (text) => codeOf(text).split('\n').map((line, at) => ({ line, n: at + 1 }));

const firstLine = (lines, test) => lines.find(({ line }) => test(line))?.n ?? null;

/** A file-name pattern as a regular expression: `*` is any run of characters in the name, anything else is itself. */
const patternOf = (pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/**
 * A class, object, interface, type alias or function declared at the start of a line, whose name other files can use.
 * A private one is not. The name is the declaration's own: after a generic and an extension's receiver, so
 * `fun View.keepClear()` defines keepClear and never View.
 */
const ANNOTATIONS = String.raw`(?:@\w+(?:\([^)]*\))?\s+)*`;
const MODIFIERS = String.raw`(?:(?:internal|public|data|sealed|enum|abstract|open|final|inner|companion|suspend|inline|operator|infix|tailrec|annotation|value|expect|actual|external|fun)\s+)*`;
// A class-like keyword is followed by the name. A function's name is the one before its `(`, after any generic and the receiver of an extension (which may hold generics of its own).
const DEFINITION = new RegExp(String.raw`^${ANNOTATIONS}${MODIFIERS}(?:(?:class|object|interface|typealias)\s+(\w+)|fun\s+(?:<.*?>\s+)?(?:[^(]*\.)?(\w+)\s*\()`);
/** The name a line of code defines, if it starts a declaration. */
const definedName = (line) => { const found = DEFINITION.exec(line); return found ? found[1] ?? found[2] : undefined; };

const byPath = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/** The line an import is written on: the first code line that quotes the specifier. */
const importLine = (lines, specifier) => firstLine(lines, (line) => ['\'', '"', '`'].some((quote) => line.includes(`${quote}${specifier}${quote}`)));

/**
 * @param {{ design: object, scan: { extensions: string[] }, candidates: { path: string, packageName?: string|null, files: { file: string, text: string|null }[] }[], callerCode?: Record<string, { file: string, text: string }[]>, designFiles?: Record<string, { file: string, text: string }[]> }} input
 * `designFiles` holds, for each folder a component names file-name patterns in, the source files directly in it.
 */
export function buildLogical({ design, scan, candidates, callerCode = {}, designFiles = {} }) {
  const chips = design.layers.flatMap((layer) => layer.items.flat().map((chip) => ({ ...chip, layer: layer.id, context: layer.kind === 'context' })));
  // A context component is drawn for its link to the code. Nothing places it, and no line reaches it but a caller's.
  const placed = chips.filter((chip) => !chip.context);
  const layerOf = new Map(chips.map((chip) => [chip.id, chip.layer]));
  const layerById = new Map(design.layers.map((layer) => [layer.id, layer]));
  const chipById = new Map(chips.map((chip) => [chip.id, chip]));
  const onDisk = new Set(candidates.map((candidate) => candidate.path));

  // ---- placement
  const owners = new Map();
  const place = (folder, owner) => owners.set(folder, [...(owners.get(folder) ?? []), owner]);
  for (const chip of placed) for (const folder of chip.folders) place(folder, chip.id);
  for (const each of design.noLine) place(each.folder, `${each.name} (drawn as no line)`);
  // A component made of file-name patterns holds the files its patterns match, in the folder it names. A file
  // no pattern matches, a file two components' patterns match and a pattern that matches nothing are recorded
  // as a folder is: by the file's path, or for a pattern the path with the pattern as its name.
  const matched = new Map();
  const emptyPatterns = [];
  for (const chip of placed.filter((each) => each.files.length > 0)) {
    for (const pattern of chip.files) {
      const test = patternOf(pattern);
      const hits = (designFiles[chip.in] ?? []).filter(({ file }) => test.test(file.slice(chip.in.length + 1)));
      if (hits.length === 0) emptyPatterns.push({ folder: `${chip.in}/${pattern}`, components: [chip.id] });
      for (const { file } of hits) {
        const by = matched.get(file) ?? [];
        if (!by.includes(chip.id)) matched.set(file, [...by, chip.id]);
      }
    }
  }
  const patternFolders = new Set(placed.filter((each) => each.files.length > 0).map((each) => each.in));
  const unmatched = [...patternFolders].flatMap((folder) => (designFiles[folder] ?? []).map(({ file }) => file)).filter((file) => !matched.has(file));
  // A design that names no folder (a service of file patterns) is not asked to place the folders of the others.
  const byFolder = (a, b) => a.folder.localeCompare(b.folder);
  const placement = {
    unplaced: [...(owners.size > 0 ? [...onDisk].filter((folder) => !owners.has(folder)) : []), ...unmatched].sort(),
    gone: [...[...owners.entries()].filter(([folder]) => !onDisk.has(folder)).map(([folder, by]) => ({ folder, components: by })), ...chips.filter((chip) => chip.context).flatMap((chip) => chip.folders.filter((folder) => !onDisk.has(folder)).map((folder) => ({ folder, components: [chip.id] }))), ...emptyPatterns].sort(byFolder),
    doubled: [...[...owners.entries()].filter(([, by]) => by.length > 1).map(([folder, by]) => ({ folder, components: by })), ...[...matched].filter(([, by]) => by.length > 1).map(([file, by]) => ({ folder: file, components: by }))].sort(byFolder),
  };

  // ---- evidence
  const areaToChip = new Map();
  for (const chip of placed) for (const folder of chip.folders) if (!areaToChip.has(folder)) areaToChip.set(folder, chip.id);
  const resolve = importResolver(scan, candidates, onDisk);
  const markers = placed.filter((chip) => chip.marker !== null).map((chip) => ({ chip, test: new RegExp(chip.marker) }));
  const filesOf = new Map(candidates.map((candidate) => [candidate.path, candidate.files]));

  // A file placed by pattern is imported by its path without the extension; the first component to match it holds it.
  const chipOfFile = new Map();
  for (const [file, by] of matched) chipOfFile.set(file.replace(/\.[cm]?[jt]sx?$/, ''), by[0]);
  const patternTarget = (file, specifier) => (specifier.startsWith('.') ? chipOfFile.get(path.posix.join(path.posix.dirname(file), specifier).replace(/\.[cm]?[jt]sx?$/, '')) : undefined);

  const evidence = [];
  // Where the lines inside are found by name: each class and function a component's files define, and the component that defines it.
  const definedBy = new Map();
  const filesOfChip = (chip) => [...matched].filter(([, by]) => by.includes(chip.id)).map(([file]) => (designFiles[chip.in] ?? []).find((each) => each.file === file)).filter((each) => each?.text != null);
  if (design.findLines === 'names') {
    for (const chip of placed.filter((each) => each.files.length > 0)) {
      for (const { text } of filesOfChip(chip)) for (const { line } of codeLines(text)) { const name = definedName(line); if (name && !definedBy.has(name)) definedBy.set(name, chip.id); }
    }
  }
  const nameTests = [...definedBy].map(([name, owner]) => ({ owner, test: new RegExp(String.raw`\b${name}\b`) }));

  for (const chip of placed.filter((each) => each.kind === 'component')) {
    const byPattern = [...matched].filter(([, by]) => by.includes(chip.id)).map(([file]) => (designFiles[chip.in] ?? []).find((each) => each.file === file));
    const files = [...chip.folders.flatMap((folder) => filesOf.get(folder) ?? []), ...byPattern].filter((each) => each.text !== null).sort(byPath);
    for (const { file, text } of files) {
      const lines = codeLines(text);
      for (const { owner, test } of nameTests) {
        if (owner === chip.id) continue;
        const line = firstLine(lines, (each) => test.test(each));
        if (line !== null) evidence.push({ from: chip.id, to: owner, via: 'import', how: '', file, line });
      }
      for (const specifier of design.findLines === 'names' ? [] : importsOf(text)) {
        const target = areaToChip.get(resolve(file, specifier)) ?? patternTarget(file, specifier);
        if (target && target !== chip.id) evidence.push({ from: chip.id, to: target, via: 'import', how: '', file, line: importLine(lines, specifier) });
      }
      for (const { chip: reached, test } of markers) {
        if (reached.id === chip.id) continue;
        const line = firstLine(lines, (each) => test.test(each));
        if (line !== null) evidence.push({ from: chip.id, to: reached.id, via: 'marker', how: reached.how, file, line });
      }
    }
  }

  // ---- the code's lines, one per pair of components
  const edges = new Map();
  for (const item of evidence) {
    const key = `${item.from}>${item.to}`;
    const edge = edges.get(key) ?? { from: item.from, to: item.to, kind: item.via === 'marker' || chipById.get(item.to).kind === 'store' ? 'store' : 'import', files: [], at: {}, how: [] };
    if (!(item.file in edge.at)) {
      edge.files.push(item.file);
      edge.at[item.file] = item.line;
    }
    if (item.how && !edge.how.includes(item.how)) edge.how.push(item.how);
    edges.set(key, edge);
  }

  // ---- the comparison
  const allowed = new Set(design.mayCall.map(([a, b]) => `${a}>${b}`));
  const inside = {};
  const within = [];
  const agg = new Map();
  const bad = [];
  for (const edge of edges.values()) {
    const a = layerOf.get(edge.from);
    const b = layerOf.get(edge.to);
    if (a === b) {
      inside[a] = (inside[a] ?? 0) + 1;
      if (layerById.get(a).drawInside) within.push({ from: edge.from, to: edge.to, kind: edge.kind, how: edge.how, files: edge.files, at: edge.at });
    } else if (allowed.has(`${a}>${b}`)) {
      const group = agg.get(`${a}>${b}`) ?? { a, b, files: [], kinds: [] };
      for (const file of edge.files) if (!group.files.includes(file)) group.files.push(file);
      const kind = edge.kind === 'store' ? 'uses' : 'imports';
      if (!group.kinds.includes(kind)) group.kinds.push(kind);
      agg.set(`${a}>${b}`, group);
    } else {
      bad.push({ ...edge, a, b, why: design.breaks[`${a}>${b}`] ?? `${layerById.get(a).title} → ${layerById.get(b).title}: not a line the design draws` });
    }
  }
  // An acceptance covers the files it names: a line is accepted when every file making it is named, and a
  // line from a file it does not name stays red, listing that file as new.
  const accepted = [];
  const red = [];
  const accepts = design.accepted ?? [];
  for (const edge of bad) {
    const known = accepts.find((each) => each.from === edge.from && each.to === edge.to);
    if (known && edge.files.every((file) => known.files.includes(file))) accepted.push({ ...edge, accepted: known });
    else red.push(known ? { ...edge, partly: known, newFiles: edge.files.filter((file) => !known.files.includes(file)) } : edge);
  }
  red.forEach((each, at) => Object.assign(each, { n: at + 1, id: `off-${at + 1}` }));
  accepted.forEach((each, at) => Object.assign(each, { id: `acc-${at + 1}` }));
  // An acceptance nothing needs any more: no deviation on its pair is made by a file it names.
  const stale = accepts.filter((each) => !bad.some((edge) => edge.from === each.from && edge.to === each.to && edge.files.some((file) => each.files.includes(file))));

  const callers = design.callers.map((caller) => {
    if (caller.code === null) return { from: caller.from, to: caller.to, how: caller.how, status: 'elsewhere', files: [], at: {}, addresses: [] };
    const test = new RegExp(caller.code.marker);
    const read = caller.code.addresses === null ? null : new RegExp(caller.code.addresses, 'g');
    const found = [];
    const at = {};
    const addresses = [];
    for (const { file, text } of [...(callerCode[caller.code.folder] ?? [])].filter(({ file }) => caller.code.only === null || caller.code.only.includes(file.split('/').pop())).sort(byPath)) {
      const lines = codeLines(text);
      // A caller that reads its addresses is found by them alone; any other, by its marker.
      const here = read === null ? [] : lines.flatMap(({ line }) => [...line.matchAll(read)].map((each) => each[1]).filter(Boolean));
      for (const address of here) if (!addresses.includes(address)) addresses.push(address);
      const line = read === null ? firstLine(lines, (each) => test.test(each)) : here.length > 0 ? firstLine(lines, (each) => new RegExp(caller.code.addresses).test(each)) : null;
      if (line !== null) {
        found.push(file);
        at[file] = line;
      }
    }
    return { from: caller.from, to: caller.to, how: caller.how, status: found.length > 0 ? 'found' : 'notFound', files: found, at, addresses };
  });

  const miss = design.mayCall.filter(([a, b]) => !agg.has(`${a}>${b}`) && !callers.some((caller) => layerOf.get(caller.from) === a && layerOf.get(caller.to) === b)).map(([a, b]) => ({ a, b }));

  // A component of file-name patterns carries the files they matched, for its link to the first and its tooltip.
  const layers = design.layers.map((layer) => ({ ...layer, items: layer.items.map((row) => row.map((chip) => (chip.files.length > 0 ? { ...chip, matched: [...matched].filter(([, by]) => by.includes(chip.id)).map(([file]) => file).sort() } : chip))) }));

  return { layers, findLines: design.findLines, mayCall: design.mayCall, noLine: design.noLine, placement, inside, within, ok: [...agg.values()], bad: red, accepted, stale, miss, callers };
}
