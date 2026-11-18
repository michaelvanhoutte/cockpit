import { boardKey, EMPTY_BOARD, newId, readPoc, writePoc, type Board, type BoardNode } from './store';

/** POC (throwaway): the arithmetic of a whiteboard, kept apart from xyflow. */

export const CARD_W = 200;
export const CARD_H = 64;
export const BOX_HEAD = 36;
export const PAD = 16;

export function sizeOf(node: BoardNode): { w: number; h: number } {
  return node.kind === 'box' ? { w: node.w, h: node.h } : { w: CARD_W, h: CARD_H };
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

/** The right edge of everything on the board, where a new thing goes. */
function freeSpot(board: Board): { x: number; y: number } {
  const tops = board.nodes.filter((node) => !node.parentId);
  if (tops.length === 0) return { x: 40, y: 40 };
  const right = Math.max(...tops.map((node) => node.x + sizeOf(node).w));
  const top = Math.min(...tops.map((node) => node.y));
  return { x: right + 80, y: top };
}

/** Grows a box until it holds every child, with room for its header. */
export function fitBox(board: Board, boxId: string): Board {
  const box = board.nodes.find((node) => node.id === boxId);
  if (!box || box.kind !== 'box') return board;
  const children = board.nodes.filter((node) => node.parentId === boxId);
  if (children.length === 0) return board;
  const w = Math.max(box.w, ...children.map((child) => child.x + sizeOf(child).w + PAD));
  const h = Math.max(box.h, ...children.map((child) => child.y + sizeOf(child).h + PAD));
  return { ...board, nodes: board.nodes.map((node) => (node.id === boxId ? { ...box, w, h } : node)) };
}

/**
 * Puts a box named `name` on the board holding `itemIds`: the cards already on
 * the board top-level are moved into it, the rest get new cards. With
 * `nodeIds`, exactly those nodes go in, and the box is drawn around them.
 */
export function boxAround(dashboardId: string, name: string, itemIds: string[], nodeIds: string[] = []): void {
  const board = readPoc<Board>(boardKey(dashboardId), EMPTY_BOARD);
  const boxId = newId();
  const chosen = nodeIds.length
    ? board.nodes.filter((node) => nodeIds.includes(node.id))
    : itemIds.flatMap((itemId) => {
        const card = board.nodes.find((node) => node.kind === 'card' && node.itemId === itemId && !node.parentId);
        return card ? [card] : [];
      });
  let nodes = [...board.nodes];
  let at: { x: number; y: number };
  if (chosen.length > 0) {
    const spots = chosen.map((node) => absolute(board, node));
    at = { x: Math.min(...spots.map((s) => s.x)) - PAD, y: Math.min(...spots.map((s) => s.y)) - BOX_HEAD - 8 };
  } else {
    at = freeSpot(board);
  }
  const box: BoardNode = { id: boxId, kind: 'box', name, x: at.x, y: at.y, w: CARD_W + 2 * PAD, h: 120 };
  nodes = nodes.map((node) => {
    if (!chosen.some((one) => one.id === node.id)) return node;
    const spot = absolute(board, node);
    return { ...node, parentId: boxId, x: spot.x - at.x, y: spot.y - at.y };
  });
  const placed = new Set(chosen.flatMap((node) => (node.kind === 'card' ? [node.itemId] : [])));
  let row = chosen.length;
  for (const itemId of itemIds) {
    if (placed.has(itemId)) continue;
    nodes.push({ id: newId(), kind: 'card', itemId, parentId: boxId, x: PAD, y: BOX_HEAD + row * (CARD_H + 12) });
    row += 1;
  }
  writePoc(boardKey(dashboardId), fitBox({ ...board, nodes: [box, ...nodes] }, boxId));
}

/** A local-only card for something the POC made up (a merged Item), placed where there is room. */
export function addLocalCard(dashboardId: string, title: string): () => void {
  const board = readPoc<Board>(boardKey(dashboardId), EMPTY_BOARD);
  const at = freeSpot(board);
  const id = newId();
  writePoc(boardKey(dashboardId), {
    ...board,
    nodes: [...board.nodes, { id, kind: 'sketch', title, x: at.x, y: at.y, local: 'merged' }],
  });
  return () => {
    const now = readPoc<Board>(boardKey(dashboardId), EMPTY_BOARD);
    writePoc(boardKey(dashboardId), { ...now, nodes: now.nodes.filter((node) => node.id !== id) });
  };
}
