import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';
import { alias, union } from 'drizzle-orm/sqlite-core';
import type { CommandPayload } from '@cockpit/shared';
import {
  FIXED_LINE_KINDS,
  LINE_KIND_ROLES,
  fixedLineKindId,
  withFixedLineKinds,
  type BoardLine,
  type ItemLink,
  type LineKind,
  type LineKindRole,
  type LineStyle,
  type Swatch,
} from '@cockpit/shared/board';
import type { AccountDb } from './client.js';
import { boardLines, commands, dashboards, itemLinks, items, lineKinds } from './schema.js';
import { getDashboard, getItem, getWorkspace, itemsOfTheRead, type ItemsOfTheRead } from './repo.js';
import { DashboardNotFoundError, ItemNotFoundError, WorkspaceNotFoundError } from './command-service.js';
import { foldName } from '../domain/names.js';

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];
type Db = AccountDb | InATransaction;

/**
 * Links between Items, a Workspace's line kinds and a board's free lines
 * ("Brainstorming: the whiteboard can't show how Items connect", issue 1831).
 * A link joins two Items of one Workspace, decided and not dismissed, and
 * belongs to them rather than to a board; a free line belongs to one
 * Dashboard's board alone. *Leads to* and *Related* are every Workspace's,
 * written the first time anything here names a kind of it.
 */

/** A link this Workspace does not have. A 404. */
export class LinkNotFoundError extends Error {
  constructor(linkId: string) {
    super(`link ${linkId} not found`);
    this.name = 'LinkNotFoundError';
  }
}

/** A line kind this Workspace does not have live. A 404. */
export class LineKindNotFoundError extends Error {
  constructor(kindId: string) {
    super(`line kind ${kindId} not found`);
    this.name = 'LineKindNotFoundError';
  }
}

/** A free line on no live board of this Workspace. A 404. */
export class LineNotFoundError extends Error {
  constructor(lineId: string) {
    super(`line ${lineId} not found`);
    this.name = 'LineNotFoundError';
  }
}

/** *Leads to* or *Related* renamed, redrawn or deleted. A 400: the kind is there, and is every Workspace's. */
export class FixedLineKindError extends Error {
  constructor(name: string) {
    super(`${name} can’t be changed or deleted.`);
    this.name = 'FixedLineKindError';
  }
}

/** A kind named as a live kind of the Workspace is, whatever its capitals. A 409. */
export class LineKindNameTakenError extends Error {
  constructor(name: string) {
    super(`There is already a line kind called ${name}.`);
    this.name = 'LineKindNameTakenError';
  }
}

// --- reads --------------------------------------------------------------------

/** The live kinds a Workspace has written, through `line_kinds_tenant_workspace`, oldest first. */
export function storedLineKinds(db: Db, tenantId: string, workspaceId: string) {
  return db
    .select({ id: lineKinds.id, name: lineKinds.name, style: lineKinds.style, colour: lineKinds.colour, arrow: lineKinds.arrow, role: lineKinds.role })
    .from(lineKinds)
    .where(and(eq(lineKinds.tenantId, tenantId), eq(lineKinds.workspaceId, workspaceId), isNull(lineKinds.deletedAt)))
    .orderBy(asc(lineKinds.position), asc(lineKinds.createdAt), asc(lineKinds.id));
}

/** A Workspace's kinds as its read lists them: *Leads to* and *Related* first, whether written yet or not, then the ones added. */
export function lineKindsOf(db: Db, tenantId: string, workspaceId: string): LineKind[] {
  const stored = storedLineKinds(db, tenantId, workspaceId)
    .all()
    .map((row) => ({ ...row, style: row.style as LineStyle, colour: row.colour as Swatch, role: row.role as LineKindRole | null }));
  return withFixedLineKinds(workspaceId, stored);
}

/** The live links with one end at an Item of the read, from that end's index, and the other end not dismissed. */
function linksAtOneEnd(db: Db, tenantId: string, workspaceId: string, of: ItemsOfTheRead, end: 'from' | 'to') {
  const other = alias(items, 'other');
  const here = end === 'from' ? itemLinks.fromItemId : itemLinks.toItemId;
  const there = end === 'from' ? itemLinks.toItemId : itemLinks.fromItemId;
  return (
    db
      .select({ id: itemLinks.id, fromItemId: itemLinks.fromItemId, toItemId: itemLinks.toItemId, kindId: itemLinks.kindId, label: itemLinks.label })
      .from(items)
      // A cross join keeps SQLite to this order: the Items read first, then the links at each, as `childRowsOfTheRead` is.
      .crossJoin(itemLinks)
      .innerJoin(other, eq(other.id, there))
      .where(
        and(
          eq(itemLinks.tenantId, items.tenantId),
          eq(here, items.id),
          isNull(itemLinks.deletedAt),
          eq(itemLinks.workspaceId, workspaceId),
          eq(items.tenantId, tenantId),
          eq(items.workspaceId, workspaceId),
          isNull(items.deletedAt),
          isNull(other.deletedAt),
          itemsOfTheRead(of),
        ),
      )
  );
}

/**
 * The links touching the Items the Workspace's read carries, through
 * `item_links_tenant_from` and `item_links_tenant_to`: a link between two read
 * Items is found from both ends and sent once.
 */
export function linksOfTheRead(db: Db, tenantId: string, workspaceId: string, of: ItemsOfTheRead) {
  return union(linksAtOneEnd(db, tenantId, workspaceId, of, 'from'), linksAtOneEnd(db, tenantId, workspaceId, of, 'to'));
}

/** Those links, each of a live kind: one whose kind was deleted is *Related*. */
export function listLinks(db: Db, tenantId: string, workspaceId: string, of: ItemsOfTheRead, kinds: readonly LineKind[]): ItemLink[] {
  const live = new Set(kinds.map((kind) => kind.id));
  const related = fixedLineKindId(workspaceId, 'related');
  return linksOfTheRead(db, tenantId, workspaceId, of)
    .all()
    .map((link) => ({ ...link, kindId: live.has(link.kindId) ? link.kindId : related }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The live free lines of a Workspace's live Dashboards, through `board_lines_tenant_dashboard`. */
export function linesOfTheBoards(db: Db, tenantId: string, workspaceId: string) {
  return db
    .select({ id: boardLines.id, dashboardId: boardLines.dashboardId, x1: boardLines.x1, y1: boardLines.y1, x2: boardLines.x2, y2: boardLines.y2, label: boardLines.label })
    .from(dashboards)
    // Driven from the Workspace's Dashboards, as `boxesOfTheBoards` is.
    .crossJoin(boardLines)
    .where(
      and(
        eq(dashboards.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
        eq(boardLines.tenantId, dashboards.tenantId),
        eq(boardLines.dashboardId, dashboards.id),
        isNull(boardLines.deletedAt),
      ),
    )
    .orderBy(asc(boardLines.createdAt), asc(boardLines.id));
}

/** What the Workspace's read carries of links, kinds and free lines. */
export function listLinksKindsAndLines(
  db: Db,
  tenantId: string,
  workspaceId: string,
  of: ItemsOfTheRead,
): { lineKinds: LineKind[]; links: ItemLink[]; lines: BoardLine[] } {
  const kinds = lineKindsOf(db, tenantId, workspaceId);
  return { lineKinds: kinds, links: listLinks(db, tenantId, workspaceId, of, kinds), lines: linesOfTheBoards(db, tenantId, workspaceId).all() };
}

// --- the commands -----------------------------------------------------------------

/** Writes *Leads to* and *Related* for the Workspace where they are not yet, before anything names one or a name is compared. */
function writeFixedKinds(tx: InATransaction, tenantId: string, workspaceId: string, at: string): void {
  LINE_KIND_ROLES.forEach((role, position) => {
    const kind = FIXED_LINE_KINDS[role];
    tx.insert(lineKinds)
      .values({
        id: fixedLineKindId(workspaceId, role),
        tenantId,
        workspaceId,
        name: kind.name,
        foldedName: foldName(kind.name),
        style: kind.style,
        colour: kind.colour,
        arrow: kind.arrow,
        role,
        position,
        createdAt: at,
      })
      .onConflictDoNothing({ target: lineKinds.id })
      .run();
  });
}

const isFixed = (workspaceId: string, kindId: string) => LINE_KIND_ROLES.some((role) => fixedLineKindId(workspaceId, role) === kindId);

/** A live kind of this Workspace, *Leads to* and *Related* whether written yet or not, or the 404 that ends the change. */
function kindToDrawWith(db: Db, tenantId: string, workspaceId: string, kindId: string): void {
  if (isFixed(workspaceId, kindId)) return;
  const kind = db.select({ deletedAt: lineKinds.deletedAt }).from(lineKinds).where(and(eq(lineKinds.tenantId, tenantId), eq(lineKinds.workspaceId, workspaceId), eq(lineKinds.id, kindId))).get();
  if (!kind || kind.deletedAt !== null) throw new LineKindNotFoundError(kindId);
}

/** An Item a link can join: this Workspace's, decided, and not dismissed. Another Workspace's is not one it can name, as on a Panel. */
function itemToLink(db: AccountDb, tenantId: string, workspaceId: string, itemId: string): void {
  const item = getItem(db, tenantId, itemId);
  if (!item || item.deletedAt !== null || !item.workspaceDecided || item.workspaceId !== workspaceId) throw new ItemNotFoundError(itemId);
}

function linkOf(db: Db, tenantId: string, workspaceId: string, linkId: string) {
  const link = db.select().from(itemLinks).where(and(eq(itemLinks.tenantId, tenantId), eq(itemLinks.id, linkId))).get();
  if (!link || link.workspaceId !== workspaceId) throw new LinkNotFoundError(linkId);
  return link;
}

/** Whether the two Items are linked that way by that kind already, other than by `except`. */
function linkedAlready(db: Db, tenantId: string, link: { fromItemId: string; toItemId: string; kindId: string }, except: string | null): boolean {
  return (
    db
      .select({ id: itemLinks.id })
      .from(itemLinks)
      .where(
        and(
          eq(itemLinks.tenantId, tenantId),
          eq(itemLinks.fromItemId, link.fromItemId),
          isNull(itemLinks.deletedAt),
          eq(itemLinks.toItemId, link.toItemId),
          eq(itemLinks.kindId, link.kindId),
          except === null ? undefined : sql`${itemLinks.id} <> ${except}`,
        ),
      )
      .get() !== undefined
  );
}

/** The live kind of this Workspace called that, whatever its capitals, other than `except`. */
function kindCalled(db: Db, tenantId: string, workspaceId: string, name: string, except: string | null): boolean {
  const folded = foldName(name);
  const stored = db
    .select({ id: lineKinds.id })
    .from(lineKinds)
    .where(and(eq(lineKinds.tenantId, tenantId), eq(lineKinds.workspaceId, workspaceId), eq(lineKinds.foldedName, folded), isNull(lineKinds.deletedAt)))
    .all()
    .some((row) => row.id !== except);
  // *Leads to* and *Related* have their names whether written yet or not.
  return stored || LINE_KIND_ROLES.some((role) => foldName(FIXED_LINE_KINDS[role].name) === folded && fixedLineKindId(workspaceId, role) !== except);
}

function lineOf(db: Db, tenantId: string, workspaceId: string, lineId: string) {
  const line = db.select().from(boardLines).where(and(eq(boardLines.tenantId, tenantId), eq(boardLines.id, lineId))).get();
  if (!line || !getDashboard(db as AccountDb, tenantId, workspaceId, line.dashboardId)) throw new LineNotFoundError(lineId);
  return line;
}

type CommandRow = typeof commands.$inferInsert;
const LINK_COMMANDS = [
  'link_items',
  'set_link_kind',
  'set_link_label',
  'unlink_items',
  'restore_link',
  'add_line_kind',
  'edit_line_kind',
  'delete_line_kind',
  'restore_line_kind',
  'draw_line',
  'set_line_label',
  'delete_line',
  'restore_line',
] as const;
type LinkCommandName = (typeof LINK_COMMANDS)[number];
const LINK_COMMAND_NAMES = new Set<string>(LINK_COMMANDS);

export function isLinkCommand(name: string): name is LinkCommandName {
  return LINK_COMMAND_NAMES.has(name);
}

/**
 * One change to links, kinds or free lines, scoped to the Workspace the
 * envelope names as every change is. Answers whether it applied; one sent
 * again, or asking for what is so already, applies nothing.
 */
export function runLinkCommand<N extends LinkCommandName>(db: AccountDb, tenantId: string, name: N, payload: CommandPayload<N>, commandRow: CommandRow): boolean {
  const write = (change: (tx: InATransaction) => void) => {
    db.transaction((tx) => {
      change(tx);
      tx.insert(commands).values(commandRow).run();
    });
    return true;
  };
  const recordOnly = () => {
    db.insert(commands).values(commandRow).run();
    return false;
  };
  switch (name) {
    case 'link_items': {
      const cmd = payload as CommandPayload<'link_items'>;
      // A resend whose command id was lost finds the link made already, whatever has happened to it since.
      if (db.select({ id: itemLinks.id }).from(itemLinks).where(eq(itemLinks.id, cmd.linkId)).get()) return recordOnly();
      itemToLink(db, tenantId, cmd.workspaceId, cmd.fromItemId);
      itemToLink(db, tenantId, cmd.workspaceId, cmd.toItemId);
      kindToDrawWith(db, tenantId, cmd.workspaceId, cmd.kindId);
      if (linkedAlready(db, tenantId, cmd, null)) return recordOnly();
      return write((tx) => {
        writeFixedKinds(tx, tenantId, cmd.workspaceId, cmd.issuedAt);
        tx.insert(itemLinks)
          .values({ id: cmd.linkId, tenantId, workspaceId: cmd.workspaceId, fromItemId: cmd.fromItemId, toItemId: cmd.toItemId, kindId: cmd.kindId, createdAt: cmd.issuedAt })
          .run();
      });
    }
    case 'set_link_kind':
    case 'set_link_label': {
      const cmd = payload as CommandPayload<'set_link_kind' | 'set_link_label'>;
      const link = linkOf(db, tenantId, cmd.workspaceId, cmd.linkId);
      if (link.deletedAt !== null) throw new LinkNotFoundError(cmd.linkId);
      if ('kindId' in cmd) kindToDrawWith(db, tenantId, cmd.workspaceId, cmd.kindId);
      return write((tx) => {
        if ('kindId' in cmd) writeFixedKinds(tx, tenantId, cmd.workspaceId, cmd.issuedAt);
        tx.update(itemLinks)
          .set('kindId' in cmd ? { kindId: cmd.kindId } : { label: cmd.label === '' ? null : cmd.label })
          .where(and(eq(itemLinks.tenantId, tenantId), eq(itemLinks.id, link.id)))
          .run();
      });
    }
    case 'unlink_items': {
      const cmd = payload as CommandPayload<'unlink_items'>;
      const link = linkOf(db, tenantId, cmd.workspaceId, cmd.linkId);
      if (link.deletedAt !== null) return recordOnly();
      return write((tx) => tx.update(itemLinks).set({ deletedAt: cmd.issuedAt }).where(and(eq(itemLinks.tenantId, tenantId), eq(itemLinks.id, link.id))).run());
    }
    case 'restore_link': {
      const cmd = payload as CommandPayload<'restore_link'>;
      const link = linkOf(db, tenantId, cmd.workspaceId, cmd.linkId);
      if (link.deletedAt === null) return recordOnly();
      // Not while either Item is dismissed, nor where the two are linked that way again.
      const gone = [link.fromItemId, link.toItemId].some((id) => getItem(db, tenantId, id)?.deletedAt !== null);
      if (gone || linkedAlready(db, tenantId, link, link.id)) return recordOnly();
      return write((tx) => tx.update(itemLinks).set({ deletedAt: null }).where(and(eq(itemLinks.tenantId, tenantId), eq(itemLinks.id, link.id))).run());
    }
    case 'add_line_kind': {
      const cmd = payload as CommandPayload<'add_line_kind'>;
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) throw new WorkspaceNotFoundError(cmd.workspaceId);
      if (db.select({ id: lineKinds.id }).from(lineKinds).where(eq(lineKinds.id, cmd.kindId)).get()) return recordOnly();
      if (kindCalled(db, tenantId, cmd.workspaceId, cmd.name, null)) throw new LineKindNameTakenError(cmd.name);
      const last = db.select({ last: max(lineKinds.position) }).from(lineKinds).where(and(eq(lineKinds.tenantId, tenantId), eq(lineKinds.workspaceId, cmd.workspaceId))).get()?.last;
      return write((tx) => {
        writeFixedKinds(tx, tenantId, cmd.workspaceId, cmd.issuedAt);
        tx.insert(lineKinds)
          .values({
            id: cmd.kindId,
            tenantId,
            workspaceId: cmd.workspaceId,
            name: cmd.name,
            foldedName: foldName(cmd.name),
            style: cmd.style,
            colour: cmd.colour,
            arrow: cmd.arrow,
            role: null,
            position: Math.max(LINE_KIND_ROLES.length, (last ?? 0) + 1),
            createdAt: cmd.issuedAt,
          })
          .run();
      });
    }
    case 'edit_line_kind':
    case 'delete_line_kind':
    case 'restore_line_kind': {
      const cmd = payload as CommandPayload<'edit_line_kind' | 'delete_line_kind' | 'restore_line_kind'>;
      const fixed = LINE_KIND_ROLES.find((role) => fixedLineKindId(cmd.workspaceId, role) === cmd.kindId);
      if (fixed) throw new FixedLineKindError(FIXED_LINE_KINDS[fixed].name);
      const kind = db.select().from(lineKinds).where(and(eq(lineKinds.tenantId, tenantId), eq(lineKinds.workspaceId, cmd.workspaceId), eq(lineKinds.id, cmd.kindId))).get();
      if (!kind) throw new LineKindNotFoundError(cmd.kindId);
      const where = and(eq(lineKinds.tenantId, tenantId), eq(lineKinds.id, kind.id));
      if (name === 'edit_line_kind') {
        const edit = cmd as CommandPayload<'edit_line_kind'>;
        if (kind.deletedAt !== null) throw new LineKindNotFoundError(cmd.kindId);
        if (kindCalled(db, tenantId, cmd.workspaceId, edit.name, kind.id)) throw new LineKindNameTakenError(edit.name);
        return write((tx) =>
          tx.update(lineKinds).set({ name: edit.name, foldedName: foldName(edit.name), style: edit.style, colour: edit.colour, arrow: edit.arrow }).where(where).run(),
        );
      }
      if (name === 'delete_line_kind') {
        // Its links keep naming it, and are read as *Related* while it is deleted.
        if (kind.deletedAt !== null) return recordOnly();
        return write((tx) => tx.update(lineKinds).set({ deletedAt: cmd.issuedAt }).where(where).run());
      }
      if (kind.deletedAt === null) return recordOnly();
      if (kindCalled(db, tenantId, cmd.workspaceId, kind.name, kind.id)) throw new LineKindNameTakenError(kind.name);
      return write((tx) => tx.update(lineKinds).set({ deletedAt: null }).where(where).run());
    }
    case 'draw_line': {
      const cmd = payload as CommandPayload<'draw_line'>;
      if (!getDashboard(db, tenantId, cmd.workspaceId, cmd.dashboardId)) throw new DashboardNotFoundError(cmd.dashboardId);
      if (db.select({ id: boardLines.id }).from(boardLines).where(eq(boardLines.id, cmd.lineId)).get()) return recordOnly();
      return write((tx) =>
        tx
          .insert(boardLines)
          .values({ id: cmd.lineId, tenantId, dashboardId: cmd.dashboardId, x1: cmd.x1, y1: cmd.y1, x2: cmd.x2, y2: cmd.y2, label: cmd.label, createdAt: cmd.issuedAt })
          .run(),
      );
    }
    case 'set_line_label':
    case 'delete_line':
    case 'restore_line': {
      const cmd = payload as CommandPayload<'set_line_label' | 'delete_line' | 'restore_line'>;
      const line = lineOf(db, tenantId, cmd.workspaceId, cmd.lineId);
      const where = and(eq(boardLines.tenantId, tenantId), eq(boardLines.id, line.id));
      if (name === 'set_line_label') {
        if (line.deletedAt !== null) throw new LineNotFoundError(cmd.lineId);
        return write((tx) => tx.update(boardLines).set({ label: (cmd as CommandPayload<'set_line_label'>).label }).where(where).run());
      }
      const gone = name === 'delete_line';
      if ((line.deletedAt !== null) === gone) return recordOnly();
      return write((tx) => tx.update(boardLines).set({ deletedAt: gone ? cmd.issuedAt : null }).where(where).run());
    }
  }
  throw new Error(`not a change to links or lines: ${name}`);
}
