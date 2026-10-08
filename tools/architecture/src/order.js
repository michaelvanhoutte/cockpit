/**
 * The dependency chain: the order of areas that leaves the fewest import files
 * pointing up, so each area sits above what it imports. Pure: areas, the file
 * counts between them and the pins in, an order out.
 *
 * Finding the best order is exponential in the number of areas, so it is
 * exact (a search over every set of areas already placed) up to EXACT_LIMIT
 * areas and a heuristic beyond: a greedy order, improved by moving one area at
 * a time while that helps. The result says which it was, and the page repeats
 * it.
 */

/** The most areas ordered by exact search; one more and the order is approximate. 2^18 sets of areas search in well under a second. */
export const EXACT_LIMIT = 18;

/** The files of areas in `order` that import an area above them. `weight(from, to)` is the number of files of `from` importing `to`. */
export function upwardFiles(order, weight) {
  let total = 0;
  for (let at = 1; at < order.length; at += 1) for (let above = 0; above < at; above += 1) total += weight(order[at], order[above]);
  return total;
}

/**
 * @param {{ paths: string[], weight: (from: string, to: string) => number, pins?: [string, string][], limit?: number }} input
 *   `paths` in the description file's order, which settles any tie; each pin is [above, below]; the pins agree with each other
 * @returns {{ order: string[], method: 'exact' | 'approximate' }}
 */
export function orderAreas({ paths, weight, pins = [], limit = EXACT_LIMIT }) {
  const n = paths.length;
  const { w, mustBeAbove } = matrices(paths, weight, pins);

  if (n <= limit) return { order: exactOrder(n, w, mustBeAbove).map((at) => paths[at]), method: 'exact' };
  return { order: approximateOrder(n, w, mustBeAbove).map((at) => paths[at]), method: 'approximate' };
}

function matrices(paths, weight, pins) {
  const index = new Map(paths.map((path, at) => [path, at]));
  const w = paths.map((from) => paths.map((to) => (from === to ? 0 : weight(from, to))));
  const mustBeAbove = paths.map(() => []); // per area, the areas pinned above it
  for (const [above, below] of pins) mustBeAbove[index.get(below)].push(index.get(above));
  return { w, mustBeAbove };
}

/** Builds the order from the top: best[set] is the least cost of placing exactly `set` first. A tie goes to the order closest to the description file's. */
function exactOrder(n, w, mustBeAbove) {
  const weightOfUpward = n * n + 1; // above any total of displacements, so a file counts for more than keeping the file's order
  const need = mustBeAbove.map((list) => list.reduce((mask, at) => mask | (1 << at), 0));
  const best = new Float64Array(1 << n).fill(Infinity);
  const last = new Int8Array(1 << n).fill(-1);
  best[0] = 0;
  const full = (1 << n) - 1;
  for (let placed = 0; placed < full; placed += 1) {
    if (best[placed] === Infinity) continue;
    let size = 0;
    for (let at = 0; at < n; at += 1) if (placed & (1 << at)) size += 1;
    for (let v = 0; v < n; v += 1) {
      if (placed & (1 << v) || need[v] & ~placed) continue;
      let up = 0;
      for (let u = 0; u < n; u += 1) if (placed & (1 << u)) up += w[v][u];
      const next = placed | (1 << v);
      const cost = best[placed] + up * weightOfUpward + Math.abs(size - v);
      if (cost < best[next]) {
        best[next] = cost;
        last[next] = v;
      }
    }
  }
  const order = [];
  for (let set = full; set !== 0; set &= ~(1 << last[set])) order.unshift(last[set]);
  return order;
}

/** A greedy order, then single moves while one saves a file. */
function approximateOrder(n, w, mustBeAbove, { moves = true } = {}) {
  const upward = (order) => upwardFiles(order, (from, to) => w[from][to]);

  // Greedy: the next area at the top is the one that most imports what is left and is least imported by it.
  const order = [];
  const left = new Set(Array.from({ length: n }, (_, at) => at));
  while (left.size > 0) {
    let pick = -1;
    let pickScore = -Infinity;
    for (const v of left) {
      if (mustBeAbove[v].some((above) => left.has(above))) continue;
      let score = 0;
      for (const u of left) score += w[v][u] - w[u][v];
      if (score > pickScore) [pick, pickScore] = [v, score];
    }
    order.push(pick);
    left.delete(pick);
  }

  // Moves: take one area out and put it back where it costs least, within its pins.
  for (let pass = 0; moves && pass < 50; pass += 1) {
    let improved = false;
    for (let v = 0; v < n; v += 1) {
      const without = order.filter((each) => each !== v);
      const lowest = Math.max(-1, ...mustBeAbove[v].map((above) => without.indexOf(above))) + 1;
      const highest = Math.min(without.length, ...without.map((each, at) => (mustBeAbove[each].includes(v) ? at : without.length)));
      let bestAt = order.indexOf(v);
      let bestCost = upward(order);
      for (let at = lowest; at <= highest; at += 1) {
        const tried = [...without.slice(0, at), v, ...without.slice(at)];
        const cost = upward(tried);
        if (cost < bestCost) [bestAt, bestCost] = [at, cost];
      }
      if (bestCost < upward(order)) {
        order.splice(0, n, ...without.slice(0, bestAt), v, ...without.slice(bestAt));
        improved = true;
      }
    }
    if (!improved) break;
  }
  return order;
}

/** The greedy order alone, for a test to hold the improved one against. */
export function greedyOrder({ paths, weight, pins = [] }) {
  const { w, mustBeAbove } = matrices(paths, weight, pins);
  return approximateOrder(paths.length, w, mustBeAbove, { moves: false }).map((at) => paths[at]);
}
