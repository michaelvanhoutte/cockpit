import { z } from 'zod';

/**
 * The Item + Association model (functional-definition.md §4.2).
 * These are the wire shapes shared by the API and the client; the database
 * schema in apps/api mirrors them with snake_case columns.
 */

/** Where an Item came from. 'internal' means created inside Cockpit. */
export const sourceSchema = z.enum(['internal', 'mail', 'slack', 'notion', 'whatsapp']);
export type Source = z.infer<typeof sourceSchema>;

export const prioritySchema = z.enum(['low', 'normal', 'high']);
export type Priority = z.infer<typeof prioritySchema>;

/** How long a title may be. A product number, not a storage one (architecture.md §4.4). */
export const TITLE_LENGTH = 200;

/**
 * An Item carries three texts, answering three different questions
 * (functional-definition.md, "An Item carries three texts"; architecture.md
 * §4.4 for the schema rationale).
 */
export const itemTitleSchema = z
  .string()
  .trim()
  .max(TITLE_LENGTH)
  .refine((title) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title), {
    message: 'a title is a single line, without tabs or line breaks',
  });

/** A description is as long as it needs to be and holds line breaks (architecture.md §4.4). */
export const itemDescriptionSchema = z.string().trim().max(60_000);

/**
 * One other way a captured note could be read, offered beside the reading
 * Cockpit already proposed (issue 297; architecture.md §4.4).
 */
export const itemReadingSchema = z.object({
  title: itemTitleSchema.refine((title) => title.length > 0, {
    message: 'a reading has to name the note',
  }),
  description: itemDescriptionSchema,
  meaning: z.string().trim().min(1),
});
export type ItemReading = z.infer<typeof itemReadingSchema>;

/**
 * Fields are kept in three groups — write-once, source-owned, app-owned
 * (architecture.md, "Schema conventions"; §4.4 for what that means field by
 * field on this schema).
 */
export const itemSchema = z.object({
  id: z.uuid(),
  tenantId: z.string(),
  /** The Workspace this Item belongs to — or, while `workspaceDecided` is false, the one it was captured from. */
  workspaceId: z.string(),
  /** Whether anybody has said which Workspace this Item belongs to (issue 165; architecture.md §4.4). Read through `workspaceIsDecided` rather than directly. */
  workspaceDecided: z.boolean(),

  // -- write-once --
  /** What arrived, or what you said, as it stood when the Item was made. See `textsFromCapture`. */
  capturedMessage: z.string().nullable(),

  // -- source-owned --
  source: sourceSchema,
  sourceId: z.string().nullable(),
  sourceLink: z.url().nullable(),
  sender: z.string().nullable(),
  sourceTimestamp: z.iso.datetime().nullable(),
  /** Tombstone written by reconciliation when the source resolved/removed it. */
  sourceResolvedAt: z.iso.datetime().nullable(),

  // -- app-owned --
  /** Permissive here, capped on the way in (`setTitleSchema`) — architecture.md §4.4. */
  title: z.string(),
  description: z.string().nullable(),
  /** When the title and description were taken over from Cockpit's own reading, and null while still Cockpit's to replace (issue 296; architecture.md §4.4). */
  textsSettledAt: z.iso.datetime().nullable(),
  /** The other ways this note could genuinely be read, where Cockpit found any (issue 297; architecture.md §4.4). */
  readings: itemReadingSchema.array().nullable(),
  /** The Panel Cockpit thinks this note belongs on, proposed rather than filed (issue 298; architecture.md §4.4). */
  proposedPanelId: z.uuid().nullable(),
  /** Why, beside the Panel above — in words meant for the row's own hover text. Null exactly when `proposedPanelId` is. */
  proposedPanelReason: z.string().nullable(),
  /** What kind of thing this is (issue 155; architecture.md §4.4). Nullable: an item with no type, or a deleted type, draws with none rather than hidden. */
  typeId: z.string().nullable(),
  /** The current, always-editable next-action label (functional-definition.md §6.1). */
  nextAction: z.string().nullable(),
  /** When this was finished with — a time rather than a flag (issue 154; architecture.md §4.4). App-owned: a re-sync never clears it. */
  completedAt: z.iso.datetime().nullable(),
  priority: prioritySchema.nullable(),
  dueDate: z.iso.date().nullable(),
  unseen: z.boolean(),
  /** Tombstone, never a hard delete (architecture.md §4.2). */
  deletedAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Item = z.infer<typeof itemSchema>;

/** What a row says about an Item nobody has named. */
export const UNTITLED = 'Untitled';

/**
 * What a row shows: the next action, or the title (functional-definition.md,
 * "A row shows the next action, or the title"; architecture.md §4.4 for why
 * this is computed rather than stored).
 */
export function itemLabel(item: Pick<Item, 'nextAction' | 'title'>): string {
  const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();

  return oneLine(item.nextAction ?? '') || oneLine(item.title) || UNTITLED;
}

/**
 * The title and description an Item is made with, from the one text capture
 * takes (architecture.md §4.4, "What names an item at capture").
 */
export function textsFromCapture(message: string): { title: string; description: string | null } {
  // Exactly what `itemTitleSchema` refuses: control characters and the line and paragraph separators.
  const oneLine = message.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  const title = cutTo(oneLine, TITLE_LENGTH);
  return { title, description: title === message ? null : message };
}

/**
 * The first `limit` characters, without splitting one in half. A character
 * outside the BMP is two code units and the cap counts code units, so a cut at
 * the limit can land between the two and leave a lone surrogate - half an emoji
 * that renders as a replacement box.
 */
function cutTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lead = text.charCodeAt(limit - 1);
  return text.slice(0, lead >= 0xd800 && lead <= 0xdbff ? limit - 1 : limit);
}

/** Whether this Item belongs to a Workspace at all yet (see `workspaceDecided`). */
export function workspaceIsDecided(item: Pick<Item, 'workspaceDecided'>): boolean {
  return item.workspaceDecided !== false;
}

/** Whether this Item has another reading genuinely worth offering right now (issue 297). */
export function itemHasOpenReadings(item: Pick<Item, 'readings' | 'textsSettledAt'>): boolean {
  return item.textsSettledAt === null && !!item.readings && item.readings.length > 0;
}

/** What an Association can point at (functional-definition.md §4.2). */
export const associationKindSchema = z.enum(['person', 'project', 'topic']);
export type AssociationKind = z.infer<typeof associationKindSchema>;

export const associationSchema = z.object({
  id: z.uuid(),
  tenantId: z.string(),
  itemId: z.uuid(),
  kind: associationKindSchema,
  /** Human label of the target ("Anna", "Project Falcon", "Research"). */
  label: z.string(),
  createdAt: z.iso.datetime(),
});
export type Association = z.infer<typeof associationSchema>;

/**
 * Names are compared trimmed and case-insensitively; the cap is a product
 * decision, not a storage one (architecture.md §4.4). Shared by
 * `dashboardNameSchema`, `panelNameSchema`, `itemTypeNameSchema` and
 * `screenSizeNameSchema` — only where uniqueness is scoped differs between them.
 */
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  /** A name is a single line — refused rather than cleaned up (architecture.md §4.4). */
  .refine((name) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name), {
    message: 'a name is a single line, without tabs or line breaks',
  });

export const workspaceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Permissive read-back field, for the reason every one below is (architecture.md §4.4). */
  name: z.string(),
  /** The Workspace's four colors (functional-definition.md, "Container hierarchy"; architecture.md §4.4). */
  color: z.string(),
  bar: z.string(),
  ground: z.string(),
  header: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** A Dashboard's name obeys exactly the rules a Workspace's does, by being the same schema (issue 32). */
export const dashboardNameSchema = workspaceNameSchema;

/**
 * A Dashboard: a named view inside a Workspace, which you switch between like
 * tabs (functional-definition.md, "Container hierarchy"; architecture.md §4.4
 * for the read-back fields).
 */
export const dashboardSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
