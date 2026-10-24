/**
 * The test explorer's snapshot as the Tests snapshot job, or for a pull request
 * the Pull request tests workflow, sends it (tools/test-explorer, `--send`):
 * documents, not rows. A snapshot is one
 * gzipped tree (the model with every `context` taken out: areas, rules, cases,
 * counts and gaps) and one gzipped document per area holding that area's
 * source lines, keyed `file:line`. The Monitor checks each part's size and
 * shape and stores the bytes it was sent; it derives nothing from them.
 */

/** The snapshots stored: `main`'s latest, and each open pull request's latest push as `pr-<number>`. */
export type Snapshot = 'main' | `pr-${number}`;

/** The snapshot an address names, or null: `main`, or `pr-` and a pull request number with no sign or leading zero. */
export const snapshotOf = (raw: string): Snapshot | null => (raw === 'main' || /^pr-[1-9]\d{0,9}$/.test(raw) ? (raw as Snapshot) : null);

/** A pull request's snapshot. */
export const pullRequestSnapshot = (number: number): Snapshot => `pr-${number}`;

/** D1 stores at most 2,000,000 bytes a row; a part keeps clear of it, leaving room for the row's keys. */
export const MAX_PART_BYTES = 1_900_000;
/** Most a part may unpack to: above the 12 MB a part at MAX_PART_BYTES unpacks to at the tree's 6.5 to 1, so only a malformed part reaches it. */
export const MAX_UNPACKED_BYTES = 16_000_000;
/** Most areas one tree may name, and so most parts a snapshot waits for: far above the product's 38. */
export const MAX_AREAS = 500;
/** Most lines one reference's source may carry: the tool keeps four either side. */
const MAX_LINES = 100;

/** A commit as the tool writes it, short or whole. */
export const COMMIT = /^[0-9a-f]{7,40}$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** What the store keeps beside a tree: its commit and the areas whose parts it waits for. */
export interface TreeFacts {
  commit: string;
  areas: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const refused = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The refusal for a part larger than a row holds, naming it and the limit. */
export const tooLarge = (part: string, bytes: number, atLeast?: 'at least') =>
  `${part} is ${atLeast ? `${atLeast} ` : ''}${bytes.toLocaleString('en')} bytes gzipped, over the ${MAX_PART_BYTES.toLocaleString('en')} a part may hold (D1 stores at most 2 MB a row).`;

/**
 * The part's JSON, unpacked from gzip, or why it cannot be read. The size is
 * checked before anything is unpacked, and the unpacking stops at
 * MAX_UNPACKED_BYTES, so a small part that unpacks to gigabytes is refused
 * having held at most that much text.
 */
export async function unpack(part: string, bytes: Uint8Array): Promise<Checked<unknown>> {
  if (bytes.byteLength > MAX_PART_BYTES) return refused(tooLarge(part, bytes.byteLength));
  // Decoded chunk by chunk, so only the text is held, never the unpacked bytes beside it.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const texts: string[] = [];
  let size = 0;
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UNPACKED_BYTES) {
        await reader.cancel();
        return refused(`${part} unpacks to more than ${MAX_UNPACKED_BYTES.toLocaleString('en')} bytes.`);
      }
      try {
        texts.push(decoder.decode(value, { stream: true }));
      } catch {
        await reader.cancel();
        return refused(`${part} is not JSON once unpacked.`);
      }
    }
  } catch {
    return refused(`${part} is not gzip.`);
  }
  try {
    texts.push(decoder.decode());
    return { ok: true, value: JSON.parse(texts.join('')) };
  } catch {
    return refused(`${part} is not JSON once unpacked.`);
  }
}

/** Every reference a node carries: its rules, their cases, and its gaps. */
function* references(node: Record<string, unknown>): Generator<unknown> {
  for (const rule of Array.isArray(node.rules) ? node.rules : []) {
    yield rule;
    if (isRecord(rule)) {
      for (const list of [rule.cases, rule.todoCases]) if (Array.isArray(list)) yield* list;
    }
  }
  for (const list of [node.filesNothingRuns, node.branchesNothingTakes]) if (Array.isArray(list)) yield* list;
}

/**
 * The tree's commit and the areas it names, or the first thing wrong with it.
 * Each node needs a key (unique: an area's part is filed under it), a label,
 * its counts, rules and children; no reference may carry its source lines,
 * which belong in the area's own part.
 */
export function checkTree(value: unknown): Checked<TreeFacts> {
  if (!isRecord(value)) return refused('The tree is not an object.');
  if (typeof value.commit !== 'string' || value.commit === '') return refused('The tree has no commit.');
  if (!COMMIT.test(value.commit)) return refused(`The tree's commit ${JSON.stringify(value.commit)} is not one.`);
  if (typeof value.coverageAvailable !== 'boolean') return refused('The tree does not say whether coverage was available.');
  if (!Array.isArray(value.tree)) return refused('The tree has no areas.');

  const areas: string[] = [];
  const seen = new Set<string>();
  const walk = (nodes: unknown[], depth: number): string | null => {
    if (depth > 20) return 'The tree nests more than 20 areas deep.';
    for (const node of nodes) {
      const at = `Area ${areas.length + 1} in tree order`;
      if (!isRecord(node)) return `${at} is not an object.`;
      const { key } = node;
      if (typeof key !== 'string' || key === '') return `${at} has no key.`;
      if (key.length > 200) return `${at} has a key over 200 characters.`;
      const named = `Area ${JSON.stringify(key)}`;
      if (seen.has(key)) return `${named} appears twice.`;
      if (typeof node.label !== 'string') return `${named} has no label.`;
      if (!isRecord(node.counts)) return `${named} has no counts.`;
      if (!Array.isArray(node.rules)) return `${named} has no rules.`;
      if (!Array.isArray(node.children)) return `${named} has no children.`;
      for (const ref of references(node)) {
        if (isRecord(ref) && 'context' in ref) return `${named} carries source lines; they belong in its own part.`;
      }
      seen.add(key);
      areas.push(key);
      if (areas.length > MAX_AREAS) return `The tree names more than ${MAX_AREAS} areas.`;
      const below = walk(node.children, depth + 1);
      if (below) return below;
    }
    return null;
  };
  const wrong = walk(value.tree, 0);
  if (wrong) return refused(wrong);
  return { ok: true, value: { commit: value.commit, areas } };
}

/** An area's source lines: `file:line` to the lines around it, each `{line, text}`. */
export function checkAreaLines(area: string, value: unknown): Checked<null> {
  const named = `Area ${JSON.stringify(area)}`;
  if (!isRecord(value)) return refused(`${named}'s source lines are not an object.`);
  for (const [at, lines] of Object.entries(value)) {
    if (!Array.isArray(lines) || lines.length > MAX_LINES) return refused(`${named}: ${JSON.stringify(at)} is not a list of at most ${MAX_LINES} lines.`);
    for (const line of lines) {
      if (!isRecord(line) || !Number.isInteger(line.line) || (line.line as number) < 1 || typeof line.text !== 'string') {
        return refused(`${named}: ${JSON.stringify(at)} holds a line that is not {line, text}.`);
      }
    }
  }
  return { ok: true, value: null };
}

/** A tree part sent as `commit`, checked whole: its size, its gzip, its shape, and that it is that commit's. */
export async function readTree(commit: string, bytes: Uint8Array): Promise<Checked<TreeFacts>> {
  const unpacked = await unpack('The tree', bytes);
  if (!unpacked.ok) return unpacked;
  const checked = checkTree(unpacked.value);
  if (!checked.ok) return checked;
  if (checked.value.commit !== commit) return refused(`The tree is commit ${checked.value.commit}, but was sent as ${commit}.`);
  return checked;
}

/** An area's part, checked whole: its size, its gzip and its shape. */
export async function readArea(area: string, bytes: Uint8Array): Promise<Checked<null>> {
  const unpacked = await unpack(`Area ${JSON.stringify(area)}`, bytes);
  if (!unpacked.ok) return unpacked;
  return checkAreaLines(area, unpacked.value);
}
