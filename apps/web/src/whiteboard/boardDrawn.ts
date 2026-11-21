import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { BoardBox, BoardCard, BoardLine, ItemLink, LineKind, Whiteboards } from '@cockpit/shared/board';
import { drawBoardWith, type Drawn } from '../drawnAhead';

/**
 * A whiteboard's own changes drawn the moment they are made ("Brainstorming:
 * give every Dashboard a whiteboard of its own", issue 1829), as the server will
 * make them, so a card dragged stays where it was let go and a box drawn is
 * there at once. Registered with the queue's drawing when the whiteboard's
 * chunk is fetched (`drawBoardWith`); nothing is sent from a board before then.
 * Bringing a deleted box, link, kind or line back has no copy to draw from and
 * waits for the read.
 */
export function boardDrawnAhead(snapshot: WorkspaceSnapshot, change: Drawn): WorkspaceSnapshot {
  if (!('workspaceId' in change.payload) || change.payload.workspaceId !== snapshot.workspace.id) return snapshot;
  // A read kept from the release before carries no links, kinds or lines.
  const was: Partial<Whiteboards> = snapshot.whiteboards ?? {};
  const boards: Whiteboards = {
    layouts: was.layouts ?? [],
    boxes: was.boxes ?? [],
    cards: was.cards ?? [],
    lineKinds: was.lineKinds ?? [],
    links: was.links ?? [],
    lines: was.lines ?? [],
  };
  const cards = (update: (cards: BoardCard[]) => BoardCard[]) => ({ ...snapshot, whiteboards: { ...boards, cards: update(boards.cards) } });
  const boxes = (update: (boxes: BoardBox[]) => BoardBox[]) => ({ ...snapshot, whiteboards: { ...boards, boxes: update(boards.boxes) } });
  const box = (boxId: string, fields: Partial<BoardBox>) => boxes((all) => all.map((one) => (one.id === boxId ? { ...one, ...fields } : one)));
  const links = (update: (links: ItemLink[]) => ItemLink[]) => ({ ...snapshot, whiteboards: { ...boards, links: update(boards.links) } });
  const link = (linkId: string, fields: Partial<ItemLink>) => links((all) => all.map((one) => (one.id === linkId ? { ...one, ...fields } : one)));
  const kinds = (update: (kinds: LineKind[]) => LineKind[]) => ({ ...snapshot, whiteboards: { ...boards, lineKinds: update(boards.lineKinds) } });
  const lines = (update: (lines: BoardLine[]) => BoardLine[]) => ({ ...snapshot, whiteboards: { ...boards, lines: update(boards.lines) } });
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
    // Links, line kinds and free lines ("Brainstorming: the whiteboard can't show how Items connect", issue 1831).
    case 'link_items': {
      const { linkId, fromItemId, toItemId, kindId } = change.payload;
      const already = boards.links.some((one) => one.id === linkId || (one.fromItemId === fromItemId && one.toItemId === toItemId && one.kindId === kindId));
      return already ? snapshot : links((all) => [...all, { id: linkId, fromItemId, toItemId, kindId, label: null }]);
    }
    case 'set_link_kind':
      return link(change.payload.linkId, { kindId: change.payload.kindId });
    case 'set_link_label':
      return link(change.payload.linkId, { label: change.payload.label === '' ? null : change.payload.label });
    case 'unlink_items':
      return links((all) => all.filter((one) => one.id !== change.payload.linkId));
    case 'add_line_kind': {
      const { kindId, name, style, colour, arrow } = change.payload;
      if (boards.lineKinds.some((one) => one.id === kindId)) return snapshot;
      return kinds((all) => [...all, { id: kindId, name, style, colour, arrow, role: null }]);
    }
    case 'edit_line_kind': {
      const { kindId, name, style, colour, arrow } = change.payload;
      return kinds((all) => all.map((one) => (one.id === kindId && one.role === null ? { ...one, name, style, colour, arrow } : one)));
    }
    case 'delete_line_kind': {
      // Its links are drawn as Related from now on, as the read will say.
      const related = boards.lineKinds.find((one) => one.role === 'related');
      const gone = boards.lineKinds.find((one) => one.id === change.payload.kindId && one.role === null);
      if (!gone) return snapshot;
      return {
        ...snapshot,
        whiteboards: {
          ...boards,
          lineKinds: boards.lineKinds.filter((one) => one !== gone),
          links: related ? boards.links.map((one) => (one.kindId === gone.id ? { ...one, kindId: related.id } : one)) : boards.links,
        },
      };
    }
    case 'draw_line': {
      const { lineId, dashboardId, x1, y1, x2, y2, label } = change.payload;
      if (boards.lines.some((one) => one.id === lineId)) return snapshot;
      return lines((all) => [...all, { id: lineId, dashboardId, x1, y1, x2, y2, label }]);
    }
    case 'set_line_label':
      return lines((all) => all.map((one) => (one.id === change.payload.lineId ? { ...one, label: change.payload.label } : one)));
    case 'delete_line':
      return lines((all) => all.filter((one) => one.id !== change.payload.lineId));
    default:
      return snapshot;
  }
}

drawBoardWith(boardDrawnAhead);
