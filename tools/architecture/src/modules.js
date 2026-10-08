/**
 * The Context and Modules views as data. Pure: the description file's parsed
 * contents and the areas read off disk in, what to draw out.
 *
 * Every area on disk appears: the description file gives it its wording and
 * its layer, and one it does not mention is marked undescribed. An area the
 * file describes that is no longer on disk is marked gone. Every source the
 * file declares is a connector, with its package (present, or gone when named
 * and not on disk) and the core files built for it. The marks (a connector
 * package importing anything but the SDK, connector code in the core) are
 * shown and decide nothing.
 */

import path from 'node:path/posix';

import { isCodeFile, isTestFile } from './description.js';
import { importsOf, names } from './scan.js';

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

/** A file's name without its folders or its extension: the words a connector's name is looked for in. */
const stemOf = (file) => path.basename(file).replace(/\.[^.]+$/, '');

/**
 * The core files built for one source: those whose file name carries its words,
 * grouped by area. Files inside the source's own package are the connector's
 * already, and the composition root is exempt.
 */
function builtFor(source, coreAreas, exempt) {
  const own = source.package ? `${source.package}/` : null;
  return coreAreas
    .map(({ area, code }) => ({
      area: area.path,
      files: code
        .filter((each) => !exempt.includes(each.file) && !(own && each.file.startsWith(own)) && names(stemOf(each.file), source))
        .map((each) => path.relative(folderOf(area), each.file))
        .sort(),
    }))
    .filter((each) => each.files.length > 0);
}

/**
 * @param {object} description the parsed description file
 * @param {{ path: string, package: boolean, role: string, files: { file: string, text: string|null }[] }[]} candidates every folder discovery found
 * @param {{ name: string, main: string|null, environments: string[] }[]} [workers] the Workers the Worker config deploys
 */
export function buildModules(description, candidates, workers = []) {
  const { scan, sources, exemptFromSources, connectorRule, releasedOnItsOwn } = description;
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
    if (!found) return { files: 0, breaches: [] };
    return {
      files: found.code.length,
      breaches: role === 'connector' ? breachesOf({ path: areaPath }, found.code, connectorRule) : [],
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
        name: area.name,
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
    .map((each) => ({ path: each, name: each, description: null, role: onDisk.get(each).role, state: 'undescribed', ...measure(each, onDisk.get(each).role) }));
  if (missing.length > 0) layers.push({ title: null, note: '', undescribed: true, areas: missing });

  const areas = layers.flatMap((layer) => layer.areas);
  const coreAreas = areas.filter((each) => each.role === 'core' && onDisk.has(each.path)).map((area) => ({ area, code: onDisk.get(area.path).code }));
  const connectors = sources.map((source) => ({
    id: source.id,
    name: source.name,
    package: source.package ? { path: source.package, state: onDisk.has(source.package) ? 'present' : 'gone' } : null,
    inCore: builtFor(source, coreAreas, exemptFromSources),
  }));

  const parts = releasedOnItsOwn.map((each) => ({
    name: each.name,
    path: each.path,
    description: each.description,
    state: candidates.some((candidate) => candidate.files.some((file) => file.file.startsWith(`${each.path}/`))) ? 'present' : 'gone',
  }));

  // Everything with code that runs is bundled into each Worker; a folder of shared config is not.
  const bundled = areas.filter((each) => each.role !== 'other' && each.state !== 'gone').map((each) => each.path);

  return {
    layers,
    connectors,
    releasedOnItsOwn: parts,
    workers: workers.map((each) => ({ name: each.name, main: each.main, environments: each.environments, areas: bundled })),
    counts: {
      areas: areas.length,
      undescribed: areas.filter((each) => each.state === 'undescribed').length,
      gone: areas.filter((each) => each.state === 'gone').length,
      connectorFilesInCore: connectors.reduce((total, each) => total + each.inCore.reduce((sum, here) => sum + here.files.length, 0), 0),
      connectorBreaches: areas.filter((each) => each.breaches.length > 0).length,
    },
  };
}
