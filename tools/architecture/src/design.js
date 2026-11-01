/**
 * The `design` section of the description file, read: the layers Cockpit is meant to have, the components
 * in them and the folders each is made of, which layer may call which, what in code means "reaching" a
 * store or an outside service, and how each caller is looked for in its own code.
 *
 * Pure: it is handed the section's parsed value and the checks description.js reads the rest of the file
 * with, so a malformed section fails the run the same way a malformed layer does.
 */

export const CHIP_KINDS = ['component', 'client', 'store', 'outside'];
export const LAYER_KINDS = ['layer', 'clients', 'outside'];

const regexSource = (source, fail, where) => {
  try {
    new RegExp(source);
  } catch (error) {
    fail(`${where} is not a regular expression (${error.message})`);
  }
  return source;
};

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
        if (chipKind === 'component' && folders.length === 0) fail(`${here} is a component and names no folder`);
        if ((chipKind === 'client' || chipKind === 'outside') && folders.length > 0) fail(`${here} is a ${chipKind} and cannot name folders`);
        const marker = chip.marker === undefined ? null : regexSource(string(chip.marker, `${here}.marker`), fail, `${here}.marker`);
        if (marker !== null && chipKind !== 'store' && chipKind !== 'outside') fail(`${here}.marker belongs on a store or an outside service`);
        return { id: chipId, name: string(chip.name, `${here}.name`), sub: chip.sub === undefined ? '' : string(chip.sub, `${here}.sub`), kind: chipKind, folders, marker, how: chip.how === undefined ? '' : string(chip.how, `${here}.how`) };
      }),
    );
    if (items.length === 0 || items.some((row) => row.length === 0)) fail(`${where}.items must hold at least one chip in each row`);
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
        marker: regexSource(string(caller.code.marker, `${where}.code.marker`), fail, `${where}.code.marker`),
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

  return { layers, mayCall, breaks, callers, noLine };
}
