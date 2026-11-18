import { boardKey, EMPTY_BOARD, newId, readPoc, writePoc, type Board, type BoardNode } from './store';

/** POC (throwaway): the arithmetic of a whiteboard, kept apart from xyflow. */

export const CARD_W = 200;
export const CARD_H = 64;
export const BOX_HEAD = 36;
export const PAD = 16;
export const ROW = CARD_H + 12;

/** Whether a node is drawn as a box: a frame, or an Item or Panel shown as one. */
export function isBoxed(node: BoardNode): boolean {
  return node.kind === 'box' || ((node.kind === 'card' || node.kind === 'panel') && node.asBox === true);
}

export function sizeOf(node: BoardNode): { w: number; h: number } {
  if (node.kind === 'box') return { w: node.w, h: node.h };
  if ((node.kind === 'card' || node.kind === 'panel') && node.asBox) return { w: node.w ?? CARD_W + 2 * PAD, h: node.h ?? 120 };
  return { w: CARD_W, h: CARD_H };
}

export function withSize(node: BoardNode, w: number, h: number): BoardNode {
  if (node.kind === 'box') return { ...node, w, h };
  if (node.kind === 'card' || node.kind === 'panel') return { ...node, w, h };
  return node;
}

export function absolute(board: Board, node: BoardNode): { x: number; y: number } {
  let x = node.x;
  let y = node.y;
  let parent = node.parentId ? board.nodes.find((one) => one.id === node.parentId) : undefined;
  while (parent) {
    x += parent.x;
    y += parent.y;
    const up = parent.parentId;
    parent = up ? board.nodes.find((one) => one.id === up) : undefined;
  }
  return { x, y };
}

/** Parents before children, which xyflow requires. */
export function ordered(nodes: BoardNode[]): BoardNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (node: BoardNode): number => {
    let d = 0;
    let at = node.parentId ? byId.get(node.parentId) : undefined;
    while (at && d < 20) {
      d += 1;
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    return d;
  };
  return [...nodes].sort((a, b) => depth(a) - depth(b));
}

/** Every node inside `id`, at any depth. */
export function descendants(board: Board, id: string): Set<string> {
  const out = new Set<string>();
  let frontier = [id];
  while (frontier.length) {
    const next = board.nodes.filter((node) => node.parentId && frontier.includes(node.parentId)).map((node) => node.id);
    next.forEach((one) => out.add(one));
    frontier = next;
  }
  return out;
}

/** The right edge of everything on the board, where a new thing goes. */
export function freeSpot(board: Board): { x: number; y: number } {
  const tops = board.nodes.filter((node) => !node.parentId);
  if (tops.length === 0) return { x: 40, y: 40 };
  const right = Math.max(...tops.map((node) => node.x + sizeOf(node).w));
  const top = Math.min(...tops.map((node) => node.y));
  return { x: right + 80, y: top };
}

/** Grows a box until it holds every child, with room for its header. */
export function fitBox(board: Board, boxId: string): Board {
  const box = board.nodes.find((node) => node.id === boxId);
  if (!box || !isBoxed(box)) return board;
  const children = board.nodes.filter((node) => node.parentId === boxId);
  const size = sizeOf(box);
  const w = Math.max(size.w, ...children.map((child) => child.x + sizeOf(child).w + PAD));
  const h = Math.max(size.h, ...children.map((child) => child.y + sizeOf(child).h + PAD));
  return { ...board, nodes: board.nodes.map((node) => (node.id === boxId ? withSize(node, w, h) : node)) };
}

/** Where the next child goes in a box: under the lowest one. */
export function nextSlot(board: Board, boxId: string): { x: number; y: number } {
  const children = board.nodes.filter((node) => node.parentId === boxId);
  if (children.length === 0) return { x: PAD, y: BOX_HEAD };
  return { x: PAD, y: Math.max(...children.map((child) => child.y + sizeOf(child).h)) + 12 };
}

/** Whether `itemId` already has a card directly in `parentId` (undefined: open board space). */
export function cardIn(board: Board, itemId: string, parentId: string | undefined): BoardNode | undefined {
  return board.nodes.find((node) => node.kind === 'card' && node.itemId === itemId && node.parentId === parentId);
}

/**
 * Draws Item `parentItemId` as a box holding `childItemIds`: cards for them
 * already on open space (or exactly `nodeIds`) are moved in, the rest get new
 * cards. The parent's own top-level card becomes the box if there is one.
 */
export function itemBoxAround(dashboardId: string, parentItemId: string, childItemIds: string[], nodeIds: string[] = []): void {
  const board = readPoc<Board>(boardKey(dashboardId), EMPTY_BOARD);
  const chosen = nodeIds.length
    ? board.nodes.filter((node) => nodeIds.includes(node.id))
    : childItemIds.flatMap((itemId) => {
        const card = cardIn(board, itemId, undefined);
        return card ? [card] : [];
      });
  const existing = cardIn(board, parentItemId, undefined);
  const boxId = existing?.id ?? newId();
  let at: { x: number; y: number };
  if (chosen.length > 0) {
    const spots = chosen.map((node) => absolute(board, node));
    at = { x: Math.min(...spots.map((s) => s.x)) - PAD, y: Math.min(...spots.map((s) => s.y)) - BOX_HEAD - 8 };
  } else if (existing) {
    at = { x: existing.x, y: existing.y };
  } else {
    at = freeSpot(board);
  }
  let nodes = board.nodes.filter((node) => node.id !== boxId);
  nodes = nodes.map((node) => {
    if (!chosen.some((one) => one.id === node.id)) return node;
    const spot = absolute(board, node);
    return { ...node, parentId: boxId, x: spot.x - at.x, y: spot.y - at.y };
  });
  const box: BoardNode = { id: boxId, kind: 'card', itemId: parentItemId, asBox: true, x: at.x, y: at.y, w: CARD_W + 2 * PAD, h: 120 };
  let next: Board = { ...board, nodes: [box, ...nodes] };
  const placed = new Set(chosen.flatMap((node) => (node.kind === 'card' ? [node.itemId] : [])));
  for (const itemId of childItemIds) {
    if (placed.has(itemId) || cardIn(next, itemId, boxId)) continue;
    next = { ...next, nodes: [...next.nodes, { id: newId(), kind: 'card', itemId, parentId: boxId, ...nextSlot(next, boxId) }] };
  }
  writePoc(boardKey(dashboardId), fitBox(next, boxId));
}

/** A card for an Item where there is room, unless open space already holds one. */
export function addCard(dashboardId: string, itemId: string): void {
  const board = readPoc<Board>(boardKey(dashboardId), EMPTY_BOARD);
  if (cardIn(board, itemId, undefined)) return;
  const at = freeSpot(board);
  writePoc(boardKey(dashboardId), { ...board, nodes: [...board.nodes, { id: newId(), kind: 'card', itemId, x: at.x, y: at.y }] });
}
