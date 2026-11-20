import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { BoardBox, BoardCard, Whiteboards } from '@cockpit/shared/board';
import { drawBoardWith, type Drawn } from '../drawnAhead';

/**
 * A whiteboard's own changes drawn the moment they are made ("Brainstorming:
 * give every Dashboard a whiteboard of its own", issue 1829), as the server will
 * make them, so a card dragged stays where it was let go and a box drawn is
 * there at once. Registered with the queue's drawing when the whiteboard's
 * chunk is fetched (`drawBoardWith`); nothing is sent from a board before then.
 * Bringing a deleted box back has no copy to draw from and waits for the read.
 */
export function boardDrawnAhead(snapshot: WorkspaceSnapshot, change: Drawn): WorkspaceSnapshot {
  if (!('workspaceId' in change.payload) || change.payload.workspaceId !== snapshot.workspace.id) return snapshot;
  const boards: Whiteboards = snapshot.whiteboards ?? { layouts: [], boxes: [], cards: [] };
  const cards = (update: (cards: BoardCard[]) => BoardCard[]) => ({ ...snapshot, whiteboards: { ...boards, cards: update(boards.cards) } });
  const boxes = (update: (boxes: BoardBox[]) => BoardBox[]) => ({ ...snapshot, whiteboards: { ...boards, boxes: update(boards.boxes) } });
  const box = (boxId: string, fields: Partial<BoardBox>) => boxes((all) => all.map((one) => (one.id === boxId ? { ...one, ...fields } : one)));
  switch (change.name) {
    case 'place_card': {
      const { cardId, dashboardId, itemId, boxId, x, y } = change.payload;
      // An Item already on that board keeps the card it has, as the server does.
      if (boards.cards.some((card) => card.dashboardId === dashboardId && card.itemId === itemId)) return snapshot;
      return cards((all) => [...all, { id: cardId, dashboardId, itemId, boxId, x, y }]);
    }
    case 'move_card': {
      const { cardId, boxId, x, y } = change.payload;
      return cards((all) => all.map((card) => (card.id === cardId ? { ...card, boxId, x, y } : card)));
    }
    case 'take_card_off':
      return cards((all) => all.filter((card) => card.id !== change.payload.cardId));
    case 'draw_box': {
      const { boxId, dashboardId, parentBoxId, label, colour, x, y, w, h } = change.payload;
      if (boards.boxes.some((one) => one.id === boxId)) return snapshot;
      return boxes((all) => [...all, { id: boxId, dashboardId, parentBoxId, label, colour, x, y, w, h, collapsed: false }]);
    }
    case 'move_box':
      return box(change.payload.boxId, { parentBoxId: change.payload.parentBoxId, x: change.payload.x, y: change.payload.y });
    case 'resize_box':
      return box(change.payload.boxId, { x: change.payload.x, y: change.payload.y, w: change.payload.w, h: change.payload.h });
    case 'rename_box':
      return box(change.payload.boxId, { label: change.payload.label });
    case 'set_box_colour':
      return box(change.payload.boxId, { colour: change.payload.colour });
    case 'set_box_collapsed':
      return box(change.payload.boxId, { collapsed: change.payload.collapsed });
    case 'delete_box': {
      // The box, every box inside it to any depth, and every card in any of them.
      const gone = new Set([change.payload.boxId]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const one of boards.boxes) {
          if (one.parentBoxId && gone.has(one.parentBoxId) && !gone.has(one.id)) {
            gone.add(one.id);
            grew = true;
          }
        }
      }
      return {
        ...snapshot,
        whiteboards: {
          ...boards,
          boxes: boards.boxes.filter((one) => !gone.has(one.id)),
          cards: boards.cards.filter((card) => !card.boxId || !gone.has(card.boxId)),
        },
      };
    }
    default:
      return snapshot;
  }
}

drawBoardWith(boardDrawnAhead);
