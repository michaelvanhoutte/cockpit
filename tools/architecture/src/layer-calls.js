/**
 * The `layer-calls` check: CI fails on every line the Logical page draws red, so the report and CI never disagree
 * about what is a call the layers do not allow. It reads the model the report draws from (`buildLogical`), not a
 * second reading of the code.
 *
 * A red line is a call between two layers that no layer's `calls` allows and no `accepted` entry covers for every file
 * making it. An accepted entry naming a file that no longer makes its call fails too, so the list only shrinks as the
 * code is fixed. Whether the list or the layers' `calls` grew against the merge base is the import check's to say
 * (scripts/lib/import-rules.mjs), since that is where the merge base is read.
 */

import { buildModel } from './model.js';
import { readCheckout } from './read.js';

export const CHECK = 'layer-calls';

const at = (edge, file) => `${file}${edge.at[file] ? `:${edge.at[file]}` : ''}`;

/**
 * Every failure of the layer-calls check over one service's Logical view. Pure.
 * @param {{ bad: object[], accepted: object[], placement: { unplaced: string[], doubled: { folder: string, components: string[] }[] }, design: { rules: { check?: string }[], accepted: { from: string, to: string, files: string[] }[] } }} logical
 * @returns {string[]}
 */
export function layerCallFailures(logical) {
  if (!logical.design.rules.some((rule) => rule.check === CHECK)) return [`docs/architecture.yml: no rule has check: ${CHECK}`];
  // A file no part holds makes no line at all, so it would escape the check; a folder two parts hold has no one layer.
  const failures = [
    ...logical.placement.unplaced.map((folder) => `${folder} is in no part of docs/architecture.yml, so its calls cannot be checked: add it to a part's code`),
    ...logical.placement.doubled.map(({ folder, components }) => `${folder} is in more than one part (${components.join(', ')}), so its calls have no one layer`),
  ];
  for (const edge of logical.bad) {
    const files = edge.partly ? edge.newFiles : edge.files;
    const known = edge.partly ? `; the accepted entry ${edge.from} -> ${edge.to} names only ${edge.partly.files.join(', ')}, and may not grow` : '';
    for (const file of files) failures.push(`${at(edge, file)} calls ${edge.to} from ${edge.from}: ${edge.why}${known}`);
  }
  // Every file an entry names must still make its call; the deviations it covers are the accepted lines and the red
  // lines it partly covers.
  const made = new Map();
  for (const edge of [...logical.accepted, ...logical.bad]) made.set(`${edge.from}>${edge.to}`, edge.files);
  for (const entry of logical.design.accepted) {
    const still = made.get(`${entry.from}>${entry.to}`) ?? [];
    for (const file of entry.files) {
      if (!still.includes(file)) failures.push(`accepted entry ${entry.from} -> ${entry.to}: ${file} no longer makes a call the layers forbid, remove it from the entry (or the entry, if it names no other file)`);
    }
  }
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
