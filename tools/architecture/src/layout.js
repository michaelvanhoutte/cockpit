/**
 * Where the Modules view puts its areas and which imports it draws. Pure: the
 * areas and the Dependencies cells in, rows and arrows out.
 *
 * An area sits on the row below everything that imports it, going by the
 * downward imports alone (a cell of kind downward or partner); an import
 * pointing up, or one an area everyone reads makes, takes no part in the rows.
 * Of the downward imports only the shortest chain is drawn: one that a longer
 * path of downward imports already covers is left out. An upward import is
 * always drawn, as the arrow back up.
 */

/**
 * @param {{ paths: string[], cells: { from: string, to: string, files: number, kind: string }[], undecidedPairs?: [string, string][] }} input
 * @returns {{ rows: Map<string, number>, down: { from: string, to: string, files: number }[], up: { from: string, to: string, files: number, tie: boolean }[] }}
 */
export function layoutModules({ paths, cells, undecidedPairs = [] }) {
  const known = new Set(paths);
  const between = cells.filter((each) => known.has(each.from) && known.has(each.to));
  const downward = between.filter((each) => each.kind === 'downward' || each.kind === 'partner');

  const parents = new Map(paths.map((each) => [each, []]));
  const children = new Map(paths.map((each) => [each, []]));
  for (const { from, to } of downward) {
    parents.get(to).push(from);
    children.get(from).push(to);
  }

  const rows = new Map();
  const depth = (path, walking = new Set()) => {
    if (rows.has(path)) return rows.get(path);
    if (walking.has(path)) return 0; // downward imports never close a loop; this keeps a malformed input from recursing for ever
    walking.add(path);
    const row = parents.get(path).reduce((deepest, parent) => Math.max(deepest, depth(parent, walking) + 1), 0);
    walking.delete(path);
    rows.set(path, row);
    return row;
  };
  for (const path of paths) depth(path);

  /** Whether `to` is reached from `from` by a path of downward imports other than the single import from -> to. */
  const coveredByLongerPath = (from, to) => {
    const seen = new Set();
    const stack = children.get(from).filter((each) => each !== to);
    while (stack.length > 0) {
      const at = stack.pop();
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...children.get(at));
    }
    return false;
  };

  const down = downward.filter((each) => !coveredByLongerPath(each.from, each.to)).map(({ from, to, files }) => ({ from, to, files }));
  const tied = (a, b) => undecidedPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const up = between.filter((each) => each.kind === 'upward').map(({ from, to, files }) => ({ from, to, files, tie: tied(from, to) }));

  return { rows, down, up };
}
