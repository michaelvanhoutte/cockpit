import type { Board3, BoxPlace } from './store';

/** POC (throwaway): where every box and card of a whiteboard is drawn, worked out from the board and the Panels. */

export const CARD_W = 200;
export const CARD_H = 64;
export const BOX_HEAD = 40;
export const PAD = 16;
export const GAP = 14;
/** A Panel holding more than this starts collapsed when it is first placed. */
export const MANY = 8;

export const boxId = (panelId: string) => `p:${panelId}`;
export const boxCardId = (panelId: string, itemId: string) => `c:${panelId}:${itemId}`;
export const openCardId = (id: string) => `o:${id}`;
export const sketchId = (id: string) => `s:${id}`;

export type Placed =
  | { id: string; kind: 'box'; panelId: string; parent?: string; x: number; y: number; w: number; h: number; collapsed: boolean; count: number }
  | { id: string; kind: 'card'; itemId: string; panelId?: string; parent?: string; x: number; y: number }
  | { id: string; kind: 'sketch'; sketch: string; title: string; x: number; y: number };

export interface Inputs {
  board: Board3;
  /** The Dashboard's Panels drawn as boxes, in their order. */
  panels: { id: string; name: string }[];
  /** Each Panel's open Items, in its order. */
  filed: (panelId: string) => string[];
  /** Child Panel → the Panel it is inside. */
  parentOf: Record<string, string>;
  /** Panel → the Item it was made from: that Item is the box, not a card in its parent. */
  panelItem: Record<string, string>;
}

/** The slot in a neat grid for the `n`th of `count` cards in a box. */
export function gridSlot(n: number, count: number): { x: number; y: number } {
  const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(count))));
  return { x: PAD + (n % cols) * (CARD_W + GAP), y: BOX_HEAD + Math.floor(n / cols) * (CARD_H + GAP) };
}

/** A parent is kept only if it is a box on this board and does not lead back to the child. */
export function cleanParents(panels: { id: string }[], parentOf: Record<string, string>): Record<string, string> {
  const here = new Set(panels.map((panel) => panel.id));
  const out: Record<string, string> = {};
  for (const panel of panels) {
    const parent = parentOf[panel.id];
    if (!parent || !here.has(parent)) continue;
    let at: string | undefined = parent;
    let loops = false;
    for (let step = 0; at && step < 50; step += 1) {
      if (at === panel.id) loops = true;
      at = parentOf[at];
    }
    if (!loops) out[panel.id] = parent;
  }
  return out;
}

export function layout(inputs: Inputs): { placed: Placed[]; missing: Record<string, BoxPlace> } {
  const { board, panels, filed, panelItem } = inputs;
  const parentOf = cleanParents(panels, inputs.parentOf);
  const childrenOf = (panelId: string) => panels.filter((panel) => parentOf[panel.id] === panelId);
  const missing: Record<string, BoxPlace> = {};
  const placed: Placed[] = [];
  const sizes = new Map<string, { w: number; h: number }>();

  /** Cards drawn in a box: what it holds, less Items drawn as boxes inside it. */
  const cardsIn = (panelId: string) => {
    const asBoxes = new Set(childrenOf(panelId).flatMap((child) => (panelItem[child.id] ? [panelItem[child.id]!] : [])));
    return filed(panelId).filter((itemId) => !asBoxes.has(itemId));
  };

  // Sizes first, innermost out, so an outer box grows to hold the boxes inside it.
  const sizeOf = (panelId: string): { w: number; h: number } => {
    const known = sizes.get(panelId);
    if (known) return known;
    const place = board.boxes[panelId] ?? missing[panelId];
    if (place?.collapsed) {
      const size = { w: CARD_W, h: CARD_H };
      sizes.set(panelId, size);
      return size;
    }
    const cards = cardsIn(panelId);
    let right = CARD_W + 2 * PAD;
    let bottom = BOX_HEAD + PAD + 20;
    cards.forEach((itemId, n) => {
      const at = board.inBox[panelId]?.[itemId] ?? gridSlot(n, cards.length);
      right = Math.max(right, at.x + CARD_W + PAD);
      bottom = Math.max(bottom, at.y + CARD_H + PAD);
    });
    let below = bottom;
    for (const child of childrenOf(panelId)) {
      const childSize = sizeOf(child.id);
      if (!board.boxes[child.id] && !missing[child.id]) {
        missing[child.id] = { x: PAD, y: below - PAD + GAP };
      }
      const at = board.boxes[child.id] ?? missing[child.id]!;
      below = Math.max(below, at.y + childSize.h + PAD);
      right = Math.max(right, at.x + childSize.w + PAD);
      bottom = Math.max(bottom, at.y + childSize.h + PAD);
    }
    const size = { w: Math.max(place?.w ?? 0, right), h: Math.max(place?.h ?? 0, bottom) };
    sizes.set(panelId, size);
    return size;
  };

  // New top-level boxes go in a row along the top of what is there.
  const tops = panels.filter((panel) => !parentOf[panel.id]);
  const known = [
    ...tops.flatMap((panel) => (board.boxes[panel.id] ? [board.boxes[panel.id]!] : [])),
    ...board.open,
    ...board.sketches,
  ];
  const top = known.length ? Math.min(...known.map((one) => one.y)) : 40;
  let x = known.length ? Math.min(...known.map((one) => one.x)) : 40;
  for (const panel of tops) {
    if (board.boxes[panel.id]) continue;
    missing[panel.id] = { x, y: 0, ...(filed(panel.id).length > MANY ? { collapsed: true } : {}) };
  }
  // Every size now, which also gives each new nested box its place below what its parent holds.
  for (const panel of panels) sizeOf(panel.id);
  const newRow = tops.filter((panel) => missing[panel.id]);
  const rowHeight = Math.max(0, ...newRow.map((panel) => sizeOf(panel.id).h));
  for (const panel of newRow) {
    missing[panel.id] = { ...missing[panel.id]!, x, y: known.length ? top - rowHeight - 80 : 40 };
    x += sizeOf(panel.id).w + 40;
  }

  const depth = (panelId: string) => {
    let d = 0;
    for (let at = parentOf[panelId]; at; at = parentOf[at]) d += 1;
    return d;
  };
  const hidden = (panelId: string): boolean => {
    for (let at = parentOf[panelId]; at; at = parentOf[at]) if ((board.boxes[at] ?? missing[at])?.collapsed) return true;
    return false;
  };
  for (const panel of [...panels].sort((a, b) => depth(a.id) - depth(b.id))) {
    if (hidden(panel.id)) continue;
    const place = board.boxes[panel.id] ?? missing[panel.id]!;
    const size = sizeOf(panel.id);
    const parent = parentOf[panel.id];
    placed.push({
      id: boxId(panel.id),
      kind: 'box',
      panelId: panel.id,
      ...(parent ? { parent: boxId(parent) } : {}),
      x: place.x,
      y: place.y,
      w: size.w,
      h: size.h,
      collapsed: place.collapsed === true,
      count: filed(panel.id).length,
    });
  }
  for (const panel of panels) {
    const place = board.boxes[panel.id] ?? missing[panel.id];
    if (hidden(panel.id) || place?.collapsed) continue;
    const cards = cardsIn(panel.id);
    cards.forEach((itemId, n) => {
      const at = board.inBox[panel.id]?.[itemId] ?? gridSlot(n, cards.length);
      placed.push({ id: boxCardId(panel.id, itemId), kind: 'card', itemId, panelId: panel.id, parent: boxId(panel.id), x: at.x, y: at.y });
    });
  }
  for (const card of board.open) placed.push({ id: openCardId(card.id), kind: 'card', itemId: card.itemId, x: card.x, y: card.y });
  for (const sketch of board.sketches) placed.push({ id: sketchId(sketch.id), kind: 'sketch', sketch: sketch.id, title: sketch.title, x: sketch.x, y: sketch.y });
  return { placed, missing };
}

/** A placed thing's position on the board itself, adding up the boxes it is in. */
export function absoluteOf(placed: Placed[], id: string): { x: number; y: number } {
  const byId = new Map(placed.map((one) => [one.id, one]));
  let at = byId.get(id);
  let x = 0;
  let y = 0;
  while (at) {
    x += at.x;
    y += at.y;
    at = 'parent' in at && at.parent ? byId.get(at.parent) : undefined;
  }
  return { x, y };
}

export function sizeOfPlaced(one: Placed): { w: number; h: number } {
  return one.kind === 'box' ? { w: one.w, h: one.h } : { w: CARD_W, h: CARD_H };
}
