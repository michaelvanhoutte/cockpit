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
 *   any other pair                  a numbered deviation, chip to chip
 *   a pair of layers the design allows that no file uses   in the design, not in the code
 *
 * Placement is checked here too: every folder the code has is in exactly one component, or is listed as
 * drawn as no line, and every folder a component names is on disk. The result is recorded, not thrown: the
 * architecture tool's test is what fails on it.
 */

import { importResolver } from './dependencies.js';
import { codeOf, importsOf } from './scan.js';

/** The lines of a file with every comment blanked out (so a match on one is not evidence), with their line numbers. */
const codeLines = (text) => codeOf(text).split('\n').map((line, at) => ({ line, n: at + 1 }));

const firstLine = (lines, test) => lines.find(({ line }) => test(line))?.n ?? null;

const byPath = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/** The line an import is written on: the first code line that quotes the specifier. */
const importLine = (lines, specifier) => firstLine(lines, (line) => ['\'', '"', '`'].some((quote) => line.includes(`${quote}${specifier}${quote}`)));

/**
 * @param {{ design: object, scan: { extensions: string[] }, candidates: { path: string, packageName?: string|null, files: { file: string, text: string|null }[] }[], callerCode?: Record<string, { file: string, text: string }[]> }} input
 */
export function buildLogical({ design, scan, candidates, callerCode = {} }) {
  const chips = design.layers.flatMap((layer) => layer.items.flat().map((chip) => ({ ...chip, layer: layer.id })));
  const layerOf = new Map(chips.map((chip) => [chip.id, chip.layer]));
  const layerById = new Map(design.layers.map((layer) => [layer.id, layer]));
  const chipById = new Map(chips.map((chip) => [chip.id, chip]));
  const onDisk = new Set(candidates.map((candidate) => candidate.path));

  // ---- placement
  const owners = new Map();
  const place = (folder, owner) => owners.set(folder, [...(owners.get(folder) ?? []), owner]);
  for (const chip of chips) for (const folder of chip.folders) place(folder, chip.id);
  for (const each of design.noLine) place(each.folder, `${each.name} (drawn as no line)`);
  const placement = {
    unplaced: [...onDisk].filter((folder) => !owners.has(folder)).sort(),
    gone: [...owners.entries()].filter(([folder]) => !onDisk.has(folder)).map(([folder, by]) => ({ folder, components: by })).sort((a, b) => a.folder.localeCompare(b.folder)),
    doubled: [...owners.entries()].filter(([, by]) => by.length > 1).map(([folder, by]) => ({ folder, components: by })).sort((a, b) => a.folder.localeCompare(b.folder)),
  };

  // ---- evidence
  const areaToChip = new Map();
  for (const chip of chips) for (const folder of chip.folders) if (!areaToChip.has(folder)) areaToChip.set(folder, chip.id);
  const resolve = importResolver(scan, candidates, onDisk);
  const markers = chips.filter((chip) => chip.marker !== null).map((chip) => ({ chip, test: new RegExp(chip.marker) }));
  const filesOf = new Map(candidates.map((candidate) => [candidate.path, candidate.files]));

  const evidence = [];
  for (const chip of chips.filter((each) => each.kind === 'component')) {
    const files = chip.folders.flatMap((folder) => filesOf.get(folder) ?? []).filter((each) => each.text !== null).sort(byPath);
    for (const { file, text } of files) {
      const lines = codeLines(text);
      for (const specifier of importsOf(text)) {
        const target = areaToChip.get(resolve(file, specifier));
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
      if (layerById.get(a).drawInside) within.push({ from: edge.from, to: edge.to, files: edge.files });
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
  bad.forEach((each, at) => Object.assign(each, { n: at + 1, id: `off-${at + 1}` }));

  const callers = design.callers.map((caller) => {
    if (caller.code === null) return { from: caller.from, to: caller.to, how: caller.how, status: 'elsewhere', files: [], at: {} };
    const test = new RegExp(caller.code.marker);
    const found = [];
    const at = {};
    for (const { file, text } of [...(callerCode[caller.code.folder] ?? [])].sort(byPath)) {
      const line = firstLine(codeLines(text), (each) => test.test(each));
      if (line !== null) {
        found.push(file);
        at[file] = line;
      }
    }
    return { from: caller.from, to: caller.to, how: caller.how, status: found.length > 0 ? 'found' : 'notFound', files: found, at };
  });

  const miss = design.mayCall.filter(([a, b]) => !agg.has(`${a}>${b}`) && !callers.some((caller) => caller.status !== 'notFound' && layerOf.get(caller.from) === a && layerOf.get(caller.to) === b)).map(([a, b]) => ({ a, b }));

  return { layers: design.layers, mayCall: design.mayCall, noLine: design.noLine, placement, inside, within, ok: [...agg.values()], bad, miss, callers };
}
