/**
 * The `layer-calls` check: CI fails on every line the Logical page draws red, unless the rules file lists it as a known
 * breach for that file. It reads the model the report draws from (`buildLogical`), not a second reading of the code, so
 * the report and CI never disagree about what is a red line.
 *
 * A red line is a call between two layers that no layer's `calls` allows and no `accepted` entry covers for every file
 * making it. An accepted call is grey and passes; a known breach stays red and passes for the files it names. A known
 * breach naming a file that no longer makes its call fails, so the list shrinks as the code is fixed, and whether it
 * grew against the merge base is the import check's to say (scripts/lib/import-rules.mjs), since that is where the
 * merge base is read. A stale accepted entry fails too, so the accepted list says only what is true.
 */

import { buildModel } from './model.js';
import { readCheckout } from './read.js';

export const CHECK = 'layer-calls';

const at = (edge, file) => `${file}${edge.at[file] ? `:${edge.at[file]}` : ''}`;
const pair = (each) => `${each.from}>${each.to}`;

/**
 * Every failure of the layer-calls check over one service's Logical view. Pure.
 * @param {{ bad: object[], accepted: object[], placement: { unplaced: string[], doubled: { folder: string, components: string[] }[] },
 *   design: { rules: { check?: string }[], accepted: { from: string, to: string, files: string[] }[], knownBreaches: { from: string, to: string, files: string[] }[] } }} logical
 * @returns {string[]}
 */
export function layerCallFailures(logical) {
  if (!logical.design.rules.some((rule) => rule.check === CHECK)) return [`docs/architecture.yml: no rule has check: ${CHECK}`];
  // A file no part holds makes no line at all, so it would escape the check; a folder two parts hold has no one layer.
  const failures = [
    ...logical.placement.unplaced.map((folder) => `${folder} is in no part of docs/architecture.yml, so its calls cannot be checked: add it to a part's code`),
    ...logical.placement.doubled.map(({ folder, components }) => `${folder} is in more than one part (${components.join(', ')}), so its calls have no one layer`),
  ];
  const known = new Map(logical.design.knownBreaches.map((each) => [pair(each), each.files]));
  for (const edge of logical.bad) {
    const files = edge.partly ? edge.newFiles : edge.files;
    const tolerated = known.get(pair(edge)) ?? [];
    for (const file of files) {
      if (tolerated.includes(file)) continue;
      const spread = tolerated.length > 0 ? `; the known breach ${edge.from} -> ${edge.to} names only ${tolerated.join(', ')}, and may not grow` : '';
      failures.push(`${at(edge, file)} calls ${edge.to} from ${edge.from}: ${edge.why}${spread}`);
    }
  }
  // Every file a list names must still make its call: an accepted call is drawn grey or partly covers a red line, a known
  // breach is drawn red.
  const accepted = new Map([...logical.accepted, ...logical.bad.filter((edge) => edge.partly)].map((edge) => [pair(edge), edge.files]));
  const red = new Map(logical.bad.map((edge) => [pair(edge), edge.partly ? edge.newFiles : edge.files]));
  const stale = (list, made, name) => {
    for (const entry of list) {
      const still = made.get(pair(entry)) ?? [];
      for (const file of entry.files) {
        if (!still.includes(file)) failures.push(`${name} ${entry.from} -> ${entry.to}: ${file} no longer makes a call the layers forbid, remove it from the entry (or the entry, if it names no other file)`);
      }
    }
  };
  stale(logical.design.accepted, accepted, 'accepted call');
  stale(logical.design.knownBreaches, red, 'known breach');
  return failures;
}

/**
 * The check over a checkout: Cockpit's Logical view, the one service whose layers are ruled inside.
 * @param {string} root absolute repository root
 */
export function layerCallsOf(root) {
  const { logical } = buildModel(readCheckout(root));
  return logical ? layerCallFailures(logical) : ['docs/architecture.yml: Cockpit has no layers to check'];
}
