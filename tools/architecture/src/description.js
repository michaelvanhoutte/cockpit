/**
 * The description file, read: the wording, the layout and the rules the Context
 * and Modules views are drawn by. The generator holds none of them, so a name
 * that becomes a source, an area that becomes a connector package, or a folder
 * that moves layer is a change to that file and to no code.
 *
 * Pure: it is handed the file's text. An unreadable or malformed file is a
 * ReadError, which fails the run like any other file the generator needs.
 */

import { parseDocument } from 'yaml';

import { ReadError } from './errors.js';

export const ROLES = ['core', 'connector', 'other'];
const DISCOVERIES = ['one', 'folders', 'packages'];

/** Whether `file` (a path from the checkout's root, with forward slashes) is a test, by the file's own pattern. */
export const isTestFile = (scan, file) => scan.testFile.test(file);

/** Whether `file` is source code the views read, by the file's own extension list. */
export const isCodeFile = (scan, file) => scan.extensions.some((extension) => file.endsWith(extension));

/** @returns the description file's contents, checked and normalised */
export function parseDescription(file, text) {
  const fail = (reason) => {
    throw new ReadError(file, reason);
  };
  const document = parseDocument(text);
  if (document.errors.length > 0) fail(`not valid YAML (${document.errors[0].message.split('\n')[0]})`);
  const value = document.toJS();
  const object = (each, where) => (each !== null && typeof each === 'object' && !Array.isArray(each) ? each : fail(`${where} must be a mapping`));
  const array = (each, where) => (Array.isArray(each) ? each : fail(`${where} must be a list`));
  const string = (each, where) => (typeof each === 'string' && each.trim() !== '' ? each.trim() : fail(`${where} must be a non-empty string`));
  const role = (each, where) => (ROLES.includes(each) ? each : fail(`${where} must be one of ${ROLES.join(', ')}`));
  const named = (list, where) => array(list, where).map((each, index) => ({ name: string(object(each, `${where}[${index}]`).name, `${where}[${index}].name`), detail: each.detail === undefined ? '' : string(each.detail, `${where}[${index}].detail`) }));

  object(value, 'the file');

  const scan = object(value.scan, 'scan');
  let testFile;
  try {
    testFile = new RegExp(string(scan.tests, 'scan.tests'));
  } catch (error) {
    fail(`scan.tests is not a regular expression (${error.message})`);
  }

  const discover = array(value.discover, 'discover').map((each, index) => {
    const where = `discover[${index}]`;
    object(each, where);
    const as = DISCOVERIES.includes(each.as) ? each.as : fail(`${where}.as must be one of ${DISCOVERIES.join(', ')}`);
    return { path: string(each.path, `${where}.path`).replace(/\/+$/, ''), as, role: role(each.role, `${where}.role`), rootFiles: each.rootFiles === true };
  });

  const sources = array(value.sources, 'sources').map((each, index) => {
    const where = `sources[${index}]`;
    object(each, where);
    const words = array(each.words, `${where}.words`).map((word, at) => string(word, `${where}.words[${at}]`));
    if (words.length === 0) fail(`${where}.words must name at least one word`);
    return { id: string(each.id, `${where}.id`), name: string(each.name, `${where}.name`), words };
  });

  const exemptFromSources = value.exemptFromSources === undefined ? [] : array(value.exemptFromSources, 'exemptFromSources').map((each, index) => string(each, `exemptFromSources[${index}]`));

  const readByEveryone = value.readByEveryone === undefined ? [] : array(value.readByEveryone, 'readByEveryone').map((each, index) => string(each, `readByEveryone[${index}]`));

  const pins = value.pins === undefined ? [] : array(value.pins, 'pins').map((each, index) => ({ above: string(object(each, `pins[${index}]`).above, `pins[${index}].above`), below: string(each.below, `pins[${index}].below`) }));

  const rule = object(value.connectorRule, 'connectorRule');

  const context = object(value.context, 'context');
  const cockpit = object(context.cockpit, 'context.cockpit');

  const seen = new Set();
  const layers = array(value.layers, 'layers').map((layer, index) => {
    const where = `layers[${index}]`;
    object(layer, where);
    const layerRole = role(layer.role, `${where}.role`);
    return {
      title: string(layer.title, `${where}.title`),
      note: layer.note === undefined || layer.note === '' ? '' : string(layer.note, `${where}.note`),
      role: layerRole,
      areas: array(layer.areas, `${where}.areas`).map((area, at) => {
        const here = `${where}.areas[${at}]`;
        object(area, here);
        const path = string(area.path, `${here}.path`);
        if (seen.has(path)) fail(`${path} is described twice`);
        seen.add(path);
        return { path, name: area.name === undefined ? path : string(area.name, `${here}.name`), description: string(area.description, `${here}.description`), role: area.role === undefined ? layerRole : role(area.role, `${here}.role`) };
      }),
    };
  });

  for (const each of readByEveryone) if (!seen.has(each)) fail(`readByEveryone names ${each}, which no layer describes`);

  for (const [index, pin] of pins.entries()) {
    for (const path of [pin.above, pin.below]) if (!seen.has(path)) fail(`pins[${index}] names ${path}, which no layer describes`);
    for (const path of [pin.above, pin.below]) if (readByEveryone.includes(path)) fail(`pins[${index}] names ${path}, which everything reads and so always comes last`);
    if (pin.above === pin.below) fail(`pins[${index}] puts ${pin.above} above itself`);
  }
  // Pins that chase each other round make no order at all.
  const below = new Map();
  for (const pin of pins) below.set(pin.above, [...(below.get(pin.above) ?? []), pin.below]);
  const reaches = (from, target, visited = new Set()) => (below.get(from) ?? []).some((next) => next === target || (!visited.has(next) && visited.add(next) && reaches(next, target, visited)));
  for (const pin of pins) if (reaches(pin.below, pin.above)) fail(`pins put ${pin.above} above ${pin.below} and ${pin.below} above ${pin.above}, in a chain`);

  return {
    pins,
    scan: { testFile, extensions: array(scan.extensions, 'scan.extensions').map((each, index) => string(each, `scan.extensions[${index}]`)), ignore: array(scan.ignore, 'scan.ignore').map((each, index) => string(each, `scan.ignore[${index}]`)) },
    discover,
    sources,
    exemptFromSources,
    readByEveryone,
    connectorRule: { sdk: string(rule.sdk, 'connectorRule.sdk'), scope: string(rule.scope, 'connectorRule.scope') },
    context: {
      cockpit: { name: string(cockpit.name, 'context.cockpit.name'), summary: string(cockpit.summary, 'context.cockpit.summary'), runs: cockpit.runs === undefined ? '' : string(cockpit.runs, 'context.cockpit.runs') },
      people: named(context.people, 'context.people'),
      services: named(context.services, 'context.services'),
    },
    layers,
  };
}
