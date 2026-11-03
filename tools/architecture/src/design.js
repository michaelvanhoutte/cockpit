/**
 * The `design` section of the description file once the rules file has completed it, read: the layers Cockpit is meant to have, the components
 * in them and the folders each is made of, which layer may call which, what in code means "reaching" a
 * store or an outside service, how each caller is looked for in its own code, and the deviations accepted with
 * a reason, each for the files it names.
 *
 * Pure: it is handed the section's parsed value and the checks description.js reads the rest of the file
 * with, so a malformed section fails the run the same way a malformed layer does.
 */

export const CHIP_KINDS = ['component', 'client', 'store', 'outside'];
// `service` is a box of another service opened to show its parts, and `context` the dotted box of the layer it talks to,
// whose components are drawn for their links to the code and are placed by nothing.
export const LAYER_KINDS = ['layer', 'clients', 'outside', 'service', 'context'];
export const LINE_FINDERS = ['names'];

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const regexSource = (source, fail, where) => {
  try {
    new RegExp(source);
  } catch (error) {
    fail(`${where} is not a regular expression (${error.message})`);
  }
  return source;
};

/**
 * The services beyond Cockpit's, each with a design of its own written the way `design` is. Each is drawn on a page
 * of its own, `service-<id>.html`.
 * @returns {{ id: string, name: string, intro: string, file: string, design: object }[]}
 */
export function parseServices(value, helpers) {
  if (value === undefined) return [];
  const { fail, object, array, string } = helpers;
  const seen = new Set(['cockpit']);
  return array(value, 'otherServices').map((each, index) => {
    const where = `otherServices[${index}]`;
    object(each, where);
    const id = string(each.id, `${where}.id`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) fail(`${where}.id must be lower case words joined by hyphens`);
    if (seen.has(id)) fail(`${where}.id ${id} is used twice`);
    seen.add(id);
    const design = parseDesign(each.design ?? fail(`${where}.design is missing`), helpers);
    return { id, name: string(each.name, `${where}.name`), intro: each.intro === undefined ? '' : string(each.intro, `${where}.intro`), file: `service-${id}.html`, design };
  });
}

/** @returns the design, checked and normalised, or null when the file has no `design` section */
export function parseDesign(value, { fail, object, array, string }) {
  if (value === undefined) return null;
  object(value, 'design');

  const layerIds = new Set();
  const chipIds = new Set();
  const layers = array(value.layers, 'design.layers').map((layer, index) => {
    const where = `design.layers[${index}]`;
    object(layer, where);
    const id = string(layer.id, `${where}.id`);
    if (layerIds.has(id)) fail(`${where}.id ${id} is used twice`);
    layerIds.add(id);
    const kind = layer.kind === undefined ? 'layer' : LAYER_KINDS.includes(layer.kind) ? layer.kind : fail(`${where}.kind must be one of ${LAYER_KINDS.join(', ')}`);
    const items = array(layer.items, `${where}.items`).map((row, at) =>
      array(row, `${where}.items[${at}]`).map((chip, to) => {
        const here = `${where}.items[${at}][${to}]`;
        object(chip, here);
        const chipId = string(chip.id, `${here}.id`);
        if (chipIds.has(chipId)) fail(`${here}.id ${chipId} is used twice`);
        chipIds.add(chipId);
        const chipKind = chip.kind === undefined ? 'component' : CHIP_KINDS.includes(chip.kind) ? chip.kind : fail(`${here}.kind must be one of ${CHIP_KINDS.join(', ')}`);
        const folders = chip.folders === undefined ? [] : array(chip.folders, `${here}.folders`).map((folder, n) => string(folder, `${here}.folders[${n}]`).replace(/\/+$/, ''));
        // A component of a service that keeps its files in one folder names file-name patterns in it instead.
        const files = chip.files === undefined ? [] : array(chip.files, `${here}.files`).map((pattern, n) => string(pattern, `${here}.files[${n}]`));
        const inFolder = chip.in === undefined ? null : string(chip.in, `${here}.in`).replace(/\/+$/, '');
        if (files.length > 0 && inFolder === null) fail(`${here}.files names file-name patterns and needs \`in\`, the folder they are matched in`);
        if (files.length === 0 && inFolder !== null) fail(`${here}.in is the folder for \`files\`, which it does not name`);
        if (chipKind === 'component' && folders.length === 0 && files.length === 0) fail(`${here} is a component and names no folder or file pattern`);
        if ((chipKind === 'client' || chipKind === 'outside') && (folders.length > 0 || files.length > 0)) fail(`${here} is a ${chipKind} and cannot name folders`);
        const href = chip.href === undefined ? null : /^[a-z0-9][a-z0-9.-]*\.html$/.test(String(chip.href)) ? chip.href : fail(`${here}.href must be the file name of a page beside this one`);
        const marker = chip.marker === undefined ? null : regexSource(string(chip.marker, `${here}.marker`), fail, `${here}.marker`);
        if (marker !== null && chipKind !== 'store' && chipKind !== 'outside') fail(`${here}.marker belongs on a store or an outside service`);
        return { id: chipId, name: string(chip.name, `${here}.name`), sub: chip.sub === undefined ? '' : string(chip.sub, `${here}.sub`), kind: chipKind, folders, in: inFolder, files, href, tip: chip.tip === undefined ? '' : string(chip.tip, `${here}.tip`), marker, how: chip.how === undefined ? '' : string(chip.how, `${here}.how`) };
      }),
    );
    if (items.length === 0 || items.some((row) => row.length === 0)) fail(`${where}.items must hold at least one chip in each row`);
    const number = (each, name) => (each === undefined ? null : typeof each === 'number' && each > 0 ? each : fail(`${where}.${name} must be a number above 0`));
    const layerHref = layer.href === undefined ? null : /^[a-z0-9][a-z0-9.-]*\.html$/.test(String(layer.href)) ? layer.href : fail(`${where}.href must be the file name of a page beside this one`);
    const share = layer.share === undefined ? null : typeof layer.share === 'number' && layer.share > 0 && layer.share <= 1 ? layer.share : fail(`${where}.share must be a number above 0 and up to 1`);
    return {
      id,
      title: string(layer.title, `${where}.title`),
      note: layer.note === undefined ? '' : string(layer.note, `${where}.note`),
      kind,
      row: layer.row === undefined ? null : Number.isInteger(layer.row) && layer.row >= 0 ? layer.row : fail(`${where}.row must be a whole number from 0`),
      share,
      alignedWith: layer.alignedWith === undefined ? null : string(layer.alignedWith, `${where}.alignedWith`),
      drawInside: layer.drawInside === true,
      href: layerHref,
      chipW: number(layer.chipW, 'chipW'),
      subGap: number(layer.subGap, 'subGap'),
      items,
    };
  });
  if (layers.length === 0) fail('design.layers must hold at least one layer');
  for (const layer of layers) if (layer.alignedWith === null && layer.row === null) fail(`design layer ${layer.id} has no row`);
  for (const layer of layers) if (layer.alignedWith !== null && !layerIds.has(layer.alignedWith)) fail(`design layer ${layer.id} is aligned with ${layer.alignedWith}, which is not a layer`);
  for (const layer of layers) if (layer.alignedWith !== null && layer.row !== null) fail(`design layer ${layer.id} is drawn beside another layer and has no row of its own`);
  if (layers.filter((layer) => layer.alignedWith !== null).length > 1) fail('design draws only one layer beside the others');

  const known = (id, where) => (layerIds.has(id) ? id : fail(`${where} names ${id}, which is not a design layer`));
  const mayCall = Object.entries(object(value.mayCall, 'design.mayCall')).flatMap(([from, to]) => {
    known(from, 'design.mayCall');
    return array(to, `design.mayCall.${from}`).map((each, at) => [from, known(string(each, `design.mayCall.${from}[${at}]`), `design.mayCall.${from}`)]);
  });

  const breaks = {};
  for (const [pair, text] of Object.entries(value.breaks === undefined ? {} : object(value.breaks, 'design.breaks'))) {
    const [a, b, ...rest] = pair.split('>');
    if (rest.length > 0 || !a || !b) fail(`design.breaks.${pair} must be written from>to`);
    known(a, `design.breaks.${pair}`);
    known(b, `design.breaks.${pair}`);
    breaks[pair] = string(text, `design.breaks.${pair}`);
  }

  const callers = (value.callers === undefined ? [] : array(value.callers, 'design.callers')).map((caller, index) => {
    const where = `design.callers[${index}]`;
    object(caller, where);
    const from = string(caller.from, `${where}.from`);
    const to = string(caller.to, `${where}.to`);
    for (const [id, name] of [[from, 'from'], [to, 'to']]) if (!chipIds.has(id)) fail(`${where}.${name} names ${id}, which is not a design chip`);
    let code = null;
    if (caller.code !== undefined) {
      object(caller.code, `${where}.code`);
      code = {
        folder: string(caller.code.folder, `${where}.code.folder`).replace(/\/+$/, ''),
        // `addresses` reads the addresses the caller calls: a regular expression whose first group is one, searched in every
        // code line. A caller that names it is found when it reads at least one, and its line is labelled with them.
        addresses: caller.code.addresses === undefined ? null : regexSource(string(caller.code.addresses, `${where}.code.addresses`), fail, `${where}.code.addresses`),
        marker: regexSource(string(caller.code.marker ?? caller.code.addresses ?? fail(`${where}.code.marker is missing`), `${where}.code.marker`), fail, `${where}.code.marker`),
        // The caller's own files in the folder, by name, where the rest of the folder is not it.
        only: caller.code.only === undefined ? null : array(caller.code.only, `${where}.code.only`).map((each, at) => string(each, `${where}.code.only[${at}]`)),
        extensions: caller.code.extensions === undefined ? null : array(caller.code.extensions, `${where}.code.extensions`).map((each, at) => string(each, `${where}.code.extensions[${at}]`)),
      };
    }
    return { from, to, how: string(caller.how, `${where}.how`), code };
  });

  const noLine = (value.noLine === undefined ? [] : array(value.noLine, 'design.noLine')).map((each, index) => {
    const where = `design.noLine[${index}]`;
    object(each, where);
    return { folder: string(each.folder, `${where}.folder`).replace(/\/+$/, ''), name: string(each.name, `${where}.name`), note: each.note === undefined ? '' : string(each.note, `${where}.note`), readByEveryone: each.readByEveryone === true };
  });

  const accepted = [];
  (value.accepted === undefined ? [] : array(value.accepted, 'design.accepted')).forEach((each, index) => {
    const where = `design.accepted[${index}]`;
    object(each, where);
    const from = string(each.from, `${where}.from`);
    const to = string(each.to, `${where}.to`);
    for (const [id, name] of [[from, 'from'], [to, 'to']]) if (!chipIds.has(id)) fail(`${where}.${name} names ${id}, which is not a design component`);
    const files = array(each.files, `${where}.files`).map((file, at) => string(file, `${where}.files[${at}]`));
    if (files.length === 0) fail(`${where}.files must name at least one file`);
    if (accepted.some((other) => other.from === from && other.to === to)) fail(`${where} accepts ${from} to ${to}, which an earlier entry already accepts`);
    accepted.push({ from, to, files, reason: string(each.reason, `${where}.reason`), source: each.source === undefined ? null : string(each.source, `${where}.source`), agreed: each.agreed === true });
  });

  // How the lines inside a layer are found where the files are not JavaScript with imports to read. `names`: a file that
  // names a class or function another component's files define uses that component.
  const findLines = value.findLines === undefined ? null : LINE_FINDERS.includes(value.findLines) ? value.findLines : fail(`design.findLines must be one of ${LINE_FINDERS.join(', ')}`);
  // The extensions of the source files a component's patterns match, where they are not the scan's own.
  const extensions = value.extensions === undefined ? null : array(value.extensions, 'design.extensions').map((each, at) => string(each, `design.extensions[${at}]`));

  // A design the rules do not rule inside is drawn by its boundary: every line between its layers is allowed.
  // What the Design tab shows besides the layers: the words of each call (by `from>to`) and of each rule that is not a call.
  const reasons = isPlain(value.reasons) ? value.reasons : {};
  const rules = Array.isArray(value.rules) ? value.rules : [];
  return { layers, mayCall, breaks, reasons, rules, callers, noLine, accepted, findLines, extensions, unruled: value.unruled === true };
}
