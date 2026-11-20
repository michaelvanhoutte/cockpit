import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { itemLabel, type CommandPayload } from '@cockpit/shared';
import type { BoardBox, BoardCard, DashboardLayout, ItemOnWhiteboards, Swatch, Whiteboards } from '@cockpit/shared/board';
import type { AccountDb } from './client.js';
import { boardBoxes, boardCards, commands, dashboards } from './schema.js';
import { getDashboard, getItem, withNoLiveParent } from './repo.js';
import { DashboardNotFoundError, ItemNotFoundError } from './command-service.js';
import { inBatchesOf } from '../domain/statements.js';

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];
type Db = AccountDb | InATransaction;

/**
 * A Dashboard's whiteboard ("Brainstorming: give every Dashboard a whiteboard
 * of its own", issue 1829): its boxes and cards, what the Workspace's read
 * carries of them, and the rule every change that moves an Item keeps - **an
 * Item in the Inbox is never on a whiteboard**. A card is placed only for an
 * Item with a live parent (filed on a live Panel, or inside a live Item: the
 * Inbox rule, `withNoLiveParent`), and a change that takes that away either
 * takes the Item's cards off in its own transaction or is refused naming them.
 * Dismissing an Item takes its cards off; bringing it back puts them back.
 */

/** A box this account does not have on a live board, or one already deleted. A 404, as a missing Item is. */
export class BoxNotFoundError extends Error {
  constructor(boxId: string) {
    super(`box ${boxId} not found`);
    this.name = 'BoxNotFoundError';
  }
}

/** A card that is not on a live board of this Workspace. A 404. */
export class CardNotFoundError extends Error {
  constructor(cardId: string) {
    super(`card ${cardId} not found`);
    this.name = 'CardNotFoundError';
  }
}

/** An Item in the Inbox dragged onto a board. A 400: the Item is there, and has to be given a place first. */
export class NotPlaceableError extends Error {
  constructor(label: string) {
    super(`${label} is in the Inbox. File it on a Panel or put it inside an Item first.`);
    this.name = 'NotPlaceableError';
  }
}

/** A box moved into itself or into a box it holds. A 400, as an Item put inside itself is. */
export class BoxInsideItselfError extends Error {
  constructor(label: string) {
    super(`${label || 'A box'} can't go inside itself or a box it holds.`);
    this.name = 'BoxInsideItselfError';
  }
}

/**
 * A change that would send Items with cards to the Inbox, sent without
 * `takeCardsOff`. A 409 carrying every such Item and its cards
 * (`onWhiteboardsRefusalSchema`), so the screen can ask "Take it off there
 * too?" and send the change again with the flag. Nothing was written.
 */
export class OnWhiteboardsError extends Error {
  constructor(readonly onWhiteboards: ItemOnWhiteboards[]) {
    const [first] = onWhiteboards;
    super(
      onWhiteboards.length === 1 && first
        ? `${first.title} is also on the whiteboard of ${first.cards.map((card) => card.dashboardName).join(', ')}. Take it off there too?`
        : `${onWhiteboards.length} Items are also on whiteboards. Take them off there too?`,
    );
    this.name = 'OnWhiteboardsError';
  }
}

// --- reads --------------------------------------------------------------------

/** The live boxes of a Workspace's live Dashboards, through `board_boxes_tenant_dashboard`. */
export function boxesOfTheBoards(db: Db, tenantId: string, workspaceId: string) {
  return db
    .select({
      id: boardBoxes.id,
      dashboardId: boardBoxes.dashboardId,
      parentBoxId: boardBoxes.parentBoxId,
      label: boardBoxes.label,
      colour: boardBoxes.colour,
      x: boardBoxes.x,
      y: boardBoxes.y,
      w: boardBoxes.w,
      h: boardBoxes.h,
      collapsed: boardBoxes.collapsed,
    })
    .from(dashboards)
    .innerJoin(boardBoxes, and(eq(boardBoxes.tenantId, dashboards.tenantId), eq(boardBoxes.dashboardId, dashboards.id), isNull(boardBoxes.deletedAt)))
    .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.workspaceId, workspaceId), isNull(dashboards.deletedAt)))
    .orderBy(asc(boardBoxes.createdAt), asc(boardBoxes.id));
}

/** The live cards of a Workspace's live Dashboards, through `board_cards_tenant_dashboard`. */
export function cardsOfTheBoards(db: Db, tenantId: string, workspaceId: string) {
  return db
    .select({ id: boardCards.id, dashboardId: boardCards.dashboardId, itemId: boardCards.itemId, boxId: boardCards.boxId, x: boardCards.x, y: boardCards.y })
    .from(dashboards)
    .innerJoin(boardCards, and(eq(boardCards.tenantId, dashboards.tenantId), eq(boardCards.dashboardId, dashboards.id), isNull(boardCards.deletedAt)))
    .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.workspaceId, workspaceId), isNull(dashboards.deletedAt)))
    .orderBy(asc(boardCards.createdAt), asc(boardCards.id));
}

/**
 * Every whiteboard of a Workspace, for its read: what each live Dashboard's
 * board holds and how each Dashboard that chose a layout is laid out. A card
 * whose box is gone is never live (`delete_box` takes it off with the box).
 */
export function listWhiteboards(db: AccountDb, tenantId: string, workspaceId: string): Whiteboards {
  const layouts: DashboardLayout[] = db
    .select({ dashboardId: dashboards.id, view: dashboards.layoutView, splitShare: dashboards.splitShare })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
        sql`(${dashboards.layoutView} IS NOT NULL OR ${dashboards.splitShare} IS NOT NULL)`,
      ),
    )
    .all()
    .map((row) => ({ ...row, view: row.view as DashboardLayout['view'] }));
  const boxes: BoardBox[] = boxesOfTheBoards(db, tenantId, workspaceId)
    .all()
    .map((row) => ({ ...row, colour: row.colour as Swatch | null }));
  const cards: BoardCard[] = cardsOfTheBoards(db, tenantId, workspaceId).all();
  return { layouts, boxes, cards };
}

/**
 * The live cards of some Items on live Dashboards, with each Dashboard's name,
 * through `board_cards_tenant_item`: what *On whiteboards* names and what a
 * change sending an Item to the Inbox has to take off. At most 49 Items a call,
 * under the 100 values a statement binds.
 */
export function cardsOfItems(db: Db, tenantId: string, itemIds: readonly string[]) {
  return db
    .select({ cardId: boardCards.id, itemId: boardCards.itemId, dashboardId: boardCards.dashboardId, dashboardName: dashboards.name })
    .from(boardCards)
    .innerJoin(dashboards, eq(dashboards.id, boardCards.dashboardId))
    .where(and(eq(boardCards.tenantId, tenantId), inArray(boardCards.itemId, [...itemIds]), isNull(boardCards.deletedAt), isNull(dashboards.deletedAt)))
    .orderBy(asc(dashboards.position), asc(dashboards.createdAt), asc(boardCards.id));
}

function liveCardsOf(db: Db, tenantId: string, itemIds: readonly string[]) {
  return inBatchesOf([...new Set(itemIds)], 2).flatMap((batch) => cardsOfItems(db, tenantId, batch).all());
}

/** Whether an Item is in the Inbox by the store's rule: filed on no live Panel and inside no live Item. */
function inTheInbox(db: Db, tenantId: string, itemId: string): boolean {
  return (db.get<{ inbox: number }>(sql`SELECT (${withNoLiveParent(tenantId, itemId)}) AS inbox`)?.inbox ?? 1) === 1;
}

// --- the rule: an Item in the Inbox is never on a whiteboard --------------------

/**
 * Called in the transaction of a change, after its writes, with every Item the
 * change could have left without a parent or dismissed. A dismissed one's cards
 * come off, stamped `at` so bringing it back puts them back. One left in the
 * Inbox with cards has them taken off where `takeOff` says so, and otherwise
 * the whole change is refused, naming each and its Dashboards, and rolled back.
 */
export function keepNoCardInTheInbox(tx: InATransaction, tenantId: string, itemIds: readonly string[], takeOff: boolean, at: string): void {
  const cards = liveCardsOf(tx, tenantId, itemIds);
  if (cards.length === 0) return;
  const goingOff: string[] = [];
  const refused: ItemOnWhiteboards[] = [];
  for (const itemId of new Set(cards.map((card) => card.itemId))) {
    const item = getItem(tx as unknown as AccountDb, tenantId, itemId);
    const its = cards.filter((card) => card.itemId === itemId);
    if (!item || item.deletedAt !== null || takeOff) {
      if (!item || item.deletedAt !== null || inTheInbox(tx, tenantId, itemId)) goingOff.push(...its.map((card) => card.cardId));
      continue;
    }
    if (inTheInbox(tx, tenantId, itemId)) {
      refused.push({
        itemId,
        title: itemLabel(item),
        cards: its.map(({ cardId, dashboardId, dashboardName }) => ({ cardId, dashboardId, dashboardName })),
      });
    }
  }
  if (refused.length > 0) throw new OnWhiteboardsError(refused);
  for (const batch of inBatchesOf(goingOff, 2)) {
    tx.update(boardCards)
      .set({ deletedAt: at })
      .where(and(eq(boardCards.tenantId, tenantId), inArray(boardCards.id, batch), isNull(boardCards.deletedAt)))
      .run();
  }
}

/**
 * Brings back cards taken off, each one only where its Item may be on a board
 * again: not dismissed, out of the Inbox, its Dashboard live, and no other card
 * of it on that board by now. One whose box is gone comes back on open space.
 * Answers how many came back. `stampedAt` limits it to the cards one change
 * took off, which is how bringing an Item back finds the ones its dismissal took.
 */
export function putBack(tx: InATransaction, tenantId: string, which: { cardIds: readonly string[] } | { itemIds: readonly string[]; stampedAt: string }): number {
  const candidates =
    'cardIds' in which
      ? inBatchesOf([...which.cardIds], 2).flatMap((batch) =>
          tx.select().from(boardCards).where(and(eq(boardCards.tenantId, tenantId), inArray(boardCards.id, batch))).all(),
        )
      : inBatchesOf([...which.itemIds], 3).flatMap((batch) =>
          tx
            .select()
            .from(boardCards)
            .where(and(eq(boardCards.tenantId, tenantId), inArray(boardCards.itemId, batch), eq(boardCards.deletedAt, which.stampedAt)))
            .all(),
        );
  let back = 0;
  for (const card of candidates) {
    if (card.deletedAt === null) continue;
    const dashboard = tx.select({ deletedAt: dashboards.deletedAt }).from(dashboards).where(eq(dashboards.id, card.dashboardId)).get();
    if (!dashboard || dashboard.deletedAt !== null) continue;
    const item = getItem(tx as unknown as AccountDb, tenantId, card.itemId);
    if (!item || item.deletedAt !== null || inTheInbox(tx, tenantId, card.itemId)) continue;
    const already = tx
      .select({ id: boardCards.id })
      .from(boardCards)
      .where(and(eq(boardCards.tenantId, tenantId), eq(boardCards.dashboardId, card.dashboardId), eq(boardCards.itemId, card.itemId), isNull(boardCards.deletedAt)))
      .get();
    if (already) continue;
    const box = card.boxId === null ? null : liveBox(tx, tenantId, card.boxId);
    tx.update(boardCards)
      .set({ deletedAt: null, ...(box ? {} : { boxId: null }) })
      .where(and(eq(boardCards.tenantId, tenantId), eq(boardCards.id, card.id)))
      .run();
    back += 1;
  }
  return back;
}

// --- the board's own commands -----------------------------------------------------

function liveBox(db: Db, tenantId: string, boxId: string) {
  const box = db.select().from(boardBoxes).where(and(eq(boardBoxes.tenantId, tenantId), eq(boardBoxes.id, boxId))).get();
  if (!box || box.deletedAt !== null) return null;
  const dashboard = db.select({ deletedAt: dashboards.deletedAt }).from(dashboards).where(eq(dashboards.id, box.dashboardId)).get();
  return dashboard && dashboard.deletedAt === null ? box : null;
}

/** A live box of a live Dashboard of this Workspace, or the 404 that ends the change. */
function boxTheChangeIsAbout(db: Db, tenantId: string, workspaceId: string, boxId: string) {
  const box = liveBox(db, tenantId, boxId);
  if (!box || !getDashboard(db as AccountDb, tenantId, workspaceId, box.dashboardId)) throw new BoxNotFoundError(boxId);
  return box;
}

/** A box another can go inside: live, and on the same board. */
function parentBoxOn(db: Db, tenantId: string, dashboardId: string, parentBoxId: string | null) {
  if (parentBoxId === null) return null;
  const parent = liveBox(db, tenantId, parentBoxId);
  if (!parent || parent.dashboardId !== dashboardId) throw new BoxNotFoundError(parentBoxId);
  return parent;
}

/** A live card of a live Dashboard of this Workspace, or the 404 that ends the change. */
function cardTheChangeIsAbout(db: Db, tenantId: string, workspaceId: string, cardId: string) {
  const card = db.select().from(boardCards).where(and(eq(boardCards.tenantId, tenantId), eq(boardCards.id, cardId))).get();
  if (!card || card.deletedAt !== null || !getDashboard(db as AccountDb, tenantId, workspaceId, card.dashboardId)) throw new CardNotFoundError(cardId);
  return card;
}

/** A box and every box inside it to any depth whose `deleted_at` is `stamp` (null: the live ones). */
function boxesWithin(db: Db, tenantId: string, box: { id: string; dashboardId: string }, stamp: string | null): string[] {
  const alike = stamp === null ? sql`b.deleted_at IS NULL` : sql`b.deleted_at = ${stamp}`;
  return db
    .all<{ id: string }>(
      sql`WITH RECURSIVE within(id) AS (
            SELECT ${box.id}
            UNION
            SELECT b.id FROM board_boxes b JOIN within ON b.parent_box_id = within.id
             WHERE b.tenant_id = ${tenantId} AND b.dashboard_id = ${box.dashboardId} AND ${alike}
          ) SELECT id FROM within`,
    )
    .map((row) => row.id);
}

type CommandRow = typeof commands.$inferInsert;
type BoardCommandName =
  | 'place_card'
  | 'move_card'
  | 'take_card_off'
  | 'put_cards_back'
  | 'draw_box'
  | 'move_box'
  | 'resize_box'
  | 'rename_box'
  | 'set_box_colour'
  | 'set_box_collapsed'
  | 'delete_box'
  | 'restore_box'
  | 'set_dashboard_view'
  | 'set_dashboard_split';

export function isBoardCommand(name: string): name is BoardCommandName {
  return BOARD_COMMANDS.has(name);
}
const BOARD_COMMANDS = new Set<string>([
  'place_card',
  'move_card',
  'take_card_off',
  'put_cards_back',
  'draw_box',
  'move_box',
  'resize_box',
  'rename_box',
  'set_box_colour',
  'set_box_collapsed',
  'delete_box',
  'restore_box',
  'set_dashboard_view',
  'set_dashboard_split',
]);

/**
 * One change to a whiteboard, scoped to the Workspace the envelope names as
 * every change is: a Dashboard, box or card of another Workspace is a 404.
 * Answers whether it applied; a resend naming a box or card already made, a
 * card taken off twice or an Item already on that board applies nothing.
 */
export function runBoardCommand<N extends BoardCommandName>(db: AccountDb, tenantId: string, name: N, payload: CommandPayload<N>, commandRow: CommandRow): boolean {
  const record = (tx: InATransaction) => tx.insert(commands).values(commandRow).run();
  const recordOnly = () => {
    db.insert(commands).values(commandRow).run();
    return false;
  };
  switch (name) {
    case 'place_card': {
      const cmd = payload as CommandPayload<'place_card'>;
      if (!getDashboard(db, tenantId, cmd.workspaceId, cmd.dashboardId)) throw new DashboardNotFoundError(cmd.dashboardId);
      const item = getItem(db, tenantId, cmd.itemId);
      // A dismissed Item is gone, and another Workspace's is not one this Workspace can name, as on a Panel.
      if (!item || item.deletedAt !== null || (item.workspaceDecided && item.workspaceId !== cmd.workspaceId)) throw new ItemNotFoundError(cmd.itemId);
      // One belonging to no Workspace yet is in every Inbox, so it is refused by the rule below.
      if (!item.workspaceDecided || inTheInbox(db, tenantId, item.id)) throw new NotPlaceableError(itemLabel(item));
      parentBoxOn(db, tenantId, cmd.dashboardId, cmd.boxId);
      if (db.select({ id: boardCards.id }).from(boardCards).where(eq(boardCards.id, cmd.cardId)).get()) return recordOnly();
      const already = db
        .select({ id: boardCards.id })
        .from(boardCards)
        .where(and(eq(boardCards.tenantId, tenantId), eq(boardCards.dashboardId, cmd.dashboardId), eq(boardCards.itemId, item.id), isNull(boardCards.deletedAt)))
        .get();
      if (already) return recordOnly();
      db.transaction((tx) => {
        tx.insert(boardCards)
          .values({ id: cmd.cardId, tenantId, dashboardId: cmd.dashboardId, itemId: item.id, boxId: cmd.boxId, x: cmd.x, y: cmd.y, createdAt: cmd.issuedAt })
          .run();
        record(tx);
      });
      return true;
    }
    case 'move_card': {
      const cmd = payload as CommandPayload<'move_card'>;
      const card = cardTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.cardId);
      parentBoxOn(db, tenantId, card.dashboardId, cmd.boxId);
      db.transaction((tx) => {
        tx.update(boardCards).set({ boxId: cmd.boxId, x: cmd.x, y: cmd.y }).where(and(eq(boardCards.tenantId, tenantId), eq(boardCards.id, card.id))).run();
        record(tx);
      });
      return true;
    }
    case 'take_card_off': {
      const cmd = payload as CommandPayload<'take_card_off'>;
      const card = db.select().from(boardCards).where(and(eq(boardCards.tenantId, tenantId), eq(boardCards.id, cmd.cardId))).get();
      if (!card || !getDashboard(db, tenantId, cmd.workspaceId, card.dashboardId)) throw new CardNotFoundError(cmd.cardId);
      if (card.deletedAt !== null) return recordOnly();
      db.transaction((tx) => {
        tx.update(boardCards).set({ deletedAt: cmd.issuedAt }).where(and(eq(boardCards.tenantId, tenantId), eq(boardCards.id, card.id))).run();
        record(tx);
      });
      return true;
    }
    case 'put_cards_back': {
      const cmd = payload as CommandPayload<'put_cards_back'>;
      // Only this Workspace's cards: the rest are not this change's to name.
      const ours = inBatchesOf([...cmd.cardIds], 2).flatMap((batch) =>
        db
          .select({ id: boardCards.id })
          .from(boardCards)
          .innerJoin(dashboards, eq(dashboards.id, boardCards.dashboardId))
          .where(and(eq(boardCards.tenantId, tenantId), inArray(boardCards.id, batch), eq(dashboards.workspaceId, cmd.workspaceId)))
          .all()
          .map((row) => row.id),
      );
      let back = 0;
      db.transaction((tx) => {
        back = putBack(tx, tenantId, { cardIds: ours });
        record(tx);
      });
      return back > 0;
    }
    case 'draw_box': {
      const cmd = payload as CommandPayload<'draw_box'>;
      if (!getDashboard(db, tenantId, cmd.workspaceId, cmd.dashboardId)) throw new DashboardNotFoundError(cmd.dashboardId);
      parentBoxOn(db, tenantId, cmd.dashboardId, cmd.parentBoxId);
      if (db.select({ id: boardBoxes.id }).from(boardBoxes).where(eq(boardBoxes.id, cmd.boxId)).get()) return recordOnly();
      db.transaction((tx) => {
        tx.insert(boardBoxes)
          .values({
            id: cmd.boxId,
            tenantId,
            dashboardId: cmd.dashboardId,
            parentBoxId: cmd.parentBoxId,
            label: cmd.label,
            colour: cmd.colour,
            x: cmd.x,
            y: cmd.y,
            w: cmd.w,
            h: cmd.h,
            createdAt: cmd.issuedAt,
          })
          .run();
        record(tx);
      });
      return true;
    }
    case 'move_box': {
      const cmd = payload as CommandPayload<'move_box'>;
      const box = boxTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.boxId);
      if (cmd.parentBoxId !== null) {
        parentBoxOn(db, tenantId, box.dashboardId, cmd.parentBoxId);
        if (boxesWithin(db, tenantId, box, null).includes(cmd.parentBoxId)) throw new BoxInsideItselfError(box.label);
      }
      db.transaction((tx) => {
        tx.update(boardBoxes)
          .set({ parentBoxId: cmd.parentBoxId, x: cmd.x, y: cmd.y })
          .where(and(eq(boardBoxes.tenantId, tenantId), eq(boardBoxes.id, box.id)))
          .run();
        record(tx);
      });
      return true;
    }
    case 'resize_box':
    case 'rename_box':
    case 'set_box_colour':
    case 'set_box_collapsed': {
      const cmd = payload as CommandPayload<'resize_box' | 'rename_box' | 'set_box_colour' | 'set_box_collapsed'>;
      const box = boxTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.boxId);
      const set =
        'w' in cmd
          ? { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }
          : 'label' in cmd
            ? { label: cmd.label }
            : 'colour' in cmd
              ? { colour: cmd.colour }
              : { collapsed: cmd.collapsed };
      db.transaction((tx) => {
        tx.update(boardBoxes).set(set).where(and(eq(boardBoxes.tenantId, tenantId), eq(boardBoxes.id, box.id))).run();
        record(tx);
      });
      return true;
    }
    case 'delete_box': {
      const cmd = payload as CommandPayload<'delete_box'>;
      const box = db.select().from(boardBoxes).where(and(eq(boardBoxes.tenantId, tenantId), eq(boardBoxes.id, cmd.boxId))).get();
      if (!box || !getDashboard(db, tenantId, cmd.workspaceId, box.dashboardId)) throw new BoxNotFoundError(cmd.boxId);
      if (box.deletedAt !== null) return recordOnly();
      const within = boxesWithin(db, tenantId, box, null);
      db.transaction((tx) => {
        // One stamp on all of it: the Undo brings back what carries it.
        for (const batch of inBatchesOf(within, 3)) {
          tx.update(boardCards)
            .set({ deletedAt: cmd.issuedAt })
            .where(and(eq(boardCards.tenantId, tenantId), inArray(boardCards.boxId, batch), isNull(boardCards.deletedAt)))
            .run();
          tx.update(boardBoxes)
            .set({ deletedAt: cmd.issuedAt })
            .where(and(eq(boardBoxes.tenantId, tenantId), inArray(boardBoxes.id, batch), isNull(boardBoxes.deletedAt)))
            .run();
        }
        record(tx);
      });
      return true;
    }
    case 'restore_box': {
      const cmd = payload as CommandPayload<'restore_box'>;
      const box = db.select().from(boardBoxes).where(and(eq(boardBoxes.tenantId, tenantId), eq(boardBoxes.id, cmd.boxId))).get();
      if (!box || !getDashboard(db, tenantId, cmd.workspaceId, box.dashboardId)) throw new BoxNotFoundError(cmd.boxId);
      if (box.deletedAt === null) return recordOnly();
      const stamp = box.deletedAt;
      const within = boxesWithin(db, tenantId, box, stamp);
      const parentGone = box.parentBoxId !== null && !liveBox(db, tenantId, box.parentBoxId);
      db.transaction((tx) => {
        for (const batch of inBatchesOf(within, 3)) {
          tx.update(boardBoxes)
            .set({ deletedAt: null })
            .where(and(eq(boardBoxes.tenantId, tenantId), inArray(boardBoxes.id, batch), eq(boardBoxes.deletedAt, stamp)))
            .run();
        }
        if (parentGone) tx.update(boardBoxes).set({ parentBoxId: null }).where(and(eq(boardBoxes.tenantId, tenantId), eq(boardBoxes.id, box.id))).run();
        const cardIds = inBatchesOf(within, 3).flatMap((batch) =>
          tx
            .select({ id: boardCards.id })
            .from(boardCards)
            .where(and(eq(boardCards.tenantId, tenantId), inArray(boardCards.boxId, batch), eq(boardCards.deletedAt, stamp)))
            .all()
            .map((row) => row.id),
        );
        putBack(tx, tenantId, { cardIds });
        record(tx);
      });
      return true;
    }
    case 'set_dashboard_view':
    case 'set_dashboard_split': {
      const cmd = payload as CommandPayload<'set_dashboard_view' | 'set_dashboard_split'>;
      if (!getDashboard(db, tenantId, cmd.workspaceId, cmd.dashboardId)) throw new DashboardNotFoundError(cmd.dashboardId);
      db.transaction((tx) => {
        tx.update(dashboards)
          .set('view' in cmd ? { layoutView: cmd.view } : { splitShare: cmd.splitShare })
          .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.id, cmd.dashboardId)))
          .run();
        record(tx);
      });
      return true;
    }
  }
  throw new Error(`not a whiteboard change: ${name}`);
}
