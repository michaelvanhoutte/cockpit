/**
 * The Context and Modules views as data. Pure: the description file's parsed
 * contents and the areas read off disk in, what to draw out.
 *
 * Every area on disk appears: the description file gives it its wording and
 * its layer, and one it does not mention is marked undescribed. An area the
 * file describes that is no longer on disk is marked gone. The marks (source
 * code in the core, a connector package importing anything but the SDK) are
 * shown and decide nothing.
 */

import path from 'node:path/posix';

import { isCodeFile, isTestFile } from './description.js';
import { codeOf, importsOf, names } from './scan.js';

export function buildContext(description) {
  return { cockpit: description.context.cockpit, people: description.context.people, services: description.context.services };
}

/** Where a candidate area's own code starts: the folder, or for the root files the folder they sit in. */
const folderOf = (area) => (area.path.endsWith('/*') ? area.path.slice(0, -2) : area.path);

/**
 * The imports that leave a connector package for anything but its SDK: another
 * workspace package (a bare name under the workspace's scope) or a relative
 * path out of the package. Third-party packages are not the SDK's business.
 */
function breachesOf(area, files, rule) {
  const own = folderOf(area);
  const found = [];
  for (const { file, text } of files) {
    for (const specifier of importsOf(text)) {
      const relative = specifier.startsWith('.');
      const leavesPackage = relative && !path.join(path.dirname(file), specifier).startsWith(`${own}/`);
      const otherWorkspace = !relative && specifier.startsWith(rule.scope) && specifier !== rule.sdk && !specifier.startsWith(`${rule.sdk}/`);
      if (leavesPackage || otherWorkspace) found.push({ file: path.relative(own, file), import: specifier });
    }
  }
  return found.sort((a, b) => a.import.localeCompare(b.import) || a.file.localeCompare(b.file));
}

/** The declared sources whose names a core area's code uses, each with the files that use one. */
function sourcesIn(area, files, sources) {
  const own = folderOf(area);
  const coded = files.map((each) => ({ file: path.relative(own, each.file), code: codeOf(each.text) }));
  return sources
    .map((source) => ({ id: source.id, name: source.name, files: coded.filter((each) => names(each.code, source)).map((each) => each.file).sort() }))
    .filter((each) => each.files.length > 0);
}

/**
 * @param {object} description the parsed description file
 * @param {{ path: string, package: boolean, role: string, files: { file: string, text: string|null }[] }[]} candidates every folder discovery found
 */
export function buildModules(description, candidates) {
  const { scan, sources, exemptFromSources, connectorRule } = description;
  const onDisk = new Map();
  for (const candidate of candidates) {
    const real = candidate.files.filter((each) => !isTestFile(scan, each.file));
    // A folder with nothing in it but tests is not an area; a package always is.
    if (real.length === 0 && !candidate.package) continue;
    const code = real.filter((each) => each.text !== null && isCodeFile(scan, each.file));
    onDisk.set(candidate.path, { role: candidate.role, code, files: real.length });
  }

  const measure = (areaPath, role) => {
    const found = onDisk.get(areaPath);
    if (!found) return { files: 0, sources: [], breaches: [] };
    const subject = { path: areaPath };
    return {
      files: found.code.length,
      sources: role === 'core' ? sourcesIn(subject, found.code.filter((each) => !exemptFromSources.includes(each.file)), sources) : [],
      breaches: role === 'connector' ? breachesOf(subject, found.code, connectorRule) : [],
    };
  };

  const described = new Set();
  const layers = description.layers.map((layer) => ({
    title: layer.title,
    note: layer.note,
    undescribed: false,
    areas: layer.areas.map((area) => {
      described.add(area.path);
      return {
        path: area.path,
        description: area.description,
        role: area.role,
        state: onDisk.has(area.path) ? 'described' : 'gone',
        ...measure(area.path, area.role),
      };
    }),
  }));

  const missing = [...onDisk.keys()]
    .filter((each) => !described.has(each))
    .sort()
    .map((each) => ({ path: each, description: null, role: onDisk.get(each).role, state: 'undescribed', ...measure(each, onDisk.get(each).role) }));
  if (missing.length > 0) layers.push({ title: null, note: '', undescribed: true, areas: missing });

  const areas = layers.flatMap((layer) => layer.areas);
  return {
    layers,
    sources: sources.map((each) => ({ id: each.id, name: each.name })),
    counts: {
      areas: areas.length,
      undescribed: areas.filter((each) => each.state === 'undescribed').length,
      gone: areas.filter((each) => each.state === 'gone').length,
      coreNamingASource: areas.filter((each) => each.sources.length > 0).length,
      connectorBreaches: areas.filter((each) => each.breaches.length > 0).length,
    },
  };
}
