/**
 * Whether an answer still has everything a sample answer has ("Read a Panel from
 * an app allowed only to read, and open Capture from its address", issue 1445):
 * every field the sample names, under the same name, of the same kind - and
 * **any field more**, since an answer only ever gains fields and an installed
 * app ignores the ones it does not know.
 *
 * Answers what is wrong, one line each, or nothing when it is still the shape.
 * A `null` in the sample says the field may be null and nothing about its kind:
 * a row with no priority is a sample of a field that has one on other rows.
 * Arrays are read entry by entry against the sample's own: the answer has at
 * least as many, which is how a case describes the scenario it was built from.
 */
export function satisfiesSample(sample: unknown, actual: unknown, path = 'the answer'): string[] {
  if (sample === null) return [];
  if (kindOf(sample) !== kindOf(actual)) return [`${path} is ${named(actual)}, not ${named(sample)}`];
  if (Array.isArray(sample)) {
    const found = actual as unknown[];
    if (found.length < sample.length) return [`${path} has ${found.length} entries, and the sample has ${sample.length}`];
    return sample.flatMap((one, at) => satisfiesSample(one, found[at], `${path}[${at}]`));
  }
  if (typeof sample === 'object') {
    const found = actual as Record<string, unknown>;
    return Object.entries(sample as Record<string, unknown>).flatMap(([key, one]) =>
      key in found ? satisfiesSample(one, found[key], `${path}.${key}`) : [`${path}.${key} is missing`],
    );
  }
  return [];
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function named(value: unknown): string {
  const kind = kindOf(value);
  if (kind === 'null') return 'null';
  return `${kind === 'array' || kind === 'object' ? 'an' : 'a'} ${kind}`;
}
