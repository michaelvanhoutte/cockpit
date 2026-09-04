import { z } from 'zod';

/**
 * The Item + Association model (functional definition §4.2).
 * These are the wire shapes shared by the API and the client; the database
 * schema in apps/api mirrors them with snake_case columns.
 */

/** Where an Item came from. 'internal' means created inside Cockpit. */
export const sourceSchema = z.enum(['internal', 'mail', 'slack', 'notion', 'whatsapp']);
export type Source = z.infer<typeof sourceSchema>;

export const prioritySchema = z.enum(['low', 'normal', 'high']);
export type Priority = z.infer<typeof prioritySchema>;

/**
 * An Item carries three texts, answering three different questions (functional
 * definition, "An Item carries three texts"): `capturedMessage` is what arrived
 * or what you said, `title` names the Item, `description` is what you have to
 * say about it. Only the last two are editable.
 *
 * A title is one line and short, because it is a row label. The 200 is a product
 * number, not a storage one - long enough for a mail subject, short enough to
 * stay a label. Empty is allowed: a title is not required, and a title of
 * nothing but blanks trims to empty rather than being refused, because there is
 * nothing to refuse it for.
 */
export const itemTitleSchema = z
  .string()
  .trim()
  .max(200)
  .refine((title) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title), {
    message: 'a title is a single line, without tabs or line breaks',
  });

/**
 * A description is as long as it needs to be and holds line breaks, being the
 * one text in the product meant to run to paragraphs. The cap is what stops one
 * Item making the copy every device holds unreasonable; 60,000 is past anything
 * typed by hand and short of a pasted mail thread. Over it is refused rather
 * than cut, because repairing input is where the bypasses live.
 *
 * Not enforced by a CHECK: adding one to `items` means rebuilding the table
 * (architecture, "A CHECK cannot be added to a table that already has
 * children"), which that section says is not worth paying for a nullable column
 * only the command handlers write.
 */
export const itemDescriptionSchema = z.string().trim().max(60_000);

/**
 * Fields are kept in three groups (architecture, "Schema conventions"): a
 * connector re-sync overwrites the source-owned group unconditionally, never
 * touches the app-owned group, and cannot reach `capturedMessage` at all, which
 * is written once when the Item is made and never again.
 *
 * `title` is app-owned rather than source-owned even though a source proposes
 * it: a subject seeds it at ingest and never afterwards, so renaming an Item
 * survives the next poll.
 */
export const itemSchema = z.object({
  id: z.uuid(),
  tenantId: z.string(),
  workspaceId: z.string(),

  // -- write-once --
  /** What arrived, or what you said, as it stood when the Item was made. */
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
  /**
   * Permissive here, and capped on the way in (`setTitleSchema`), for the
   * reason `typeId` below is permissive: what is stored has to render even
   * where it predates a rule. `capture_item` accepted an uncapped title until
   * this change, so a title longer than the cap can exist - and this shape is
   * parsed for the whole snapshot at once, so refusing one would blank the
   * workspace rather than draw one row oddly. The read model does not
   * re-enforce what the write path already refuses.
   */
  title: z.string(),
  description: z.string().nullable(),
  /**
   * What kind of thing this is ("Capture a thought or an action, and see which
   * it is", issue 155). Nullable: an item captured before types existed, and
   * one whose type was deleted, both have none, and a row with no type is drawn
   * rather than hidden.
   *
   * The permissive `z.string()` rather than a uuid, for the reason every other
   * id read back here is permissive: the *Action* and *Thought* every account
   * starts with have ids derived from the account's own. A `z.uuid()` here
   * refused the whole snapshot the first time an item was captured as one of
   * them, which is a blank workspace rather than one item drawn oddly.
   */
  typeId: z.string().nullable(),
  /** The current, always-editable next-action label (functional definition §6.1). */
  nextAction: z.string().nullable(),
  /**
   * When this was finished with, and the whole of what "done" means ("An item
   * is either yours to deal with or finished with", issue 154).
   *
   * A time rather than a flag, because the two things that ask are "is this
   * still yours to deal with" and "when did you finish it", and a flag answers
   * only the first. It is app-owned: a re-sync from a source never clears it.
   */
  completedAt: z.iso.datetime().nullable(),
  priority: prioritySchema.nullable(),
  dueDate: z.iso.date().nullable(),
  unseen: z.boolean(),
  /** Tombstone, never a hard delete (architecture §4.2). */
  deletedAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Item = z.infer<typeof itemSchema>;

/** How much of the captured message can stand in for a label. */
export const LABEL_LENGTH = 150;

/** What a row says about an Item with nothing written in any of its three texts. */
export const UNTITLED = 'Untitled';

/**
 * What a row shows: the next action, or the title, or the start of the captured
 * message (functional definition, "A row shows the next action, or the title,
 * or the first 150 characters of the captured message").
 *
 * Worked out where the row is drawn rather than stored as a fourth text, which
 * would be free to go stale behind the three it stands for.
 *
 * **Blank counts as absent**, for the next action and the title alike: a title
 * of spaces is stored as the empty string.
 *
 * **And when all three are blank it says so**, rather than returning nothing.
 * An Item made before it had a captured message keeps its only text in its
 * title, so clearing that title empties every one of the three - and a row, a
 * drag and an offer to undo would each render as a gap where a name should be.
 * There is no length at which an unlabelled row is better off unlabelled.
 * **Runs of whitespace collapse**, because a captured message may run to
 * paragraphs and a row is one line - and the cut has to land in the label a
 * person sees, not 150 characters into one full of newlines.
 */
export function itemLabel(
  item: Pick<Item, 'nextAction' | 'title' | 'capturedMessage'>,
): string {
  const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();

  const nextAction = oneLine(item.nextAction ?? '');
  if (nextAction) return nextAction;

  const title = oneLine(item.title);
  if (title) return title;

  const captured = oneLine(item.capturedMessage ?? '');
  if (captured.length > LABEL_LENGTH) return `${captured.slice(0, LABEL_LENGTH)}…`;
  return captured || UNTITLED;
}

/** What an Association can point at (functional definition §4.2). */
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
 * Names are compared with the surrounding blanks removed and without regard to
 * case, so `" Personal "` and `personal` are the same name. `.trim()` runs
 * before the length checks, which is what makes a name of nothing but blanks
 * fail `min(1)` rather than being stored as an empty string.
 *
 * The cap is a product decision, not a storage one: a workspace name is a tab
 * label, and there is no length at which one stays readable in a tab and
 * unreadable at 60.
 */
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  /**
   * A name is a single line. A tab or a newline inside one breaks every place
   * it is displayed and is nothing a person meant to type, so it is refused
   * rather than cleaned up - repairing input is where the bypasses live.
   *
   * `\p{Cc}` is the C0 and C1 control characters, and `\p{Zl}`/`\p{Zp}` are the
   * line and paragraph separators - not control characters at all, and a
   * browser breaks the line on U+2028 as readily as on a newline, so a name
   * holding one still renders over two lines. `.trim()` above takes them off
   * the ends and leaves the interior alone, which is where they would sit.
   *
   * Not `\p{Cf}`, which would take the zero-width joiner with it and refuse
   * half the emoji anybody would put in a name.
   */
  .refine((name) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name), {
    message: 'a name is a single line, without tabs or line breaks',
  });

export const workspaceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /**
   * Deliberately the permissive `z.string()` and not `workspaceNameSchema`:
   * this is the shape read back, and a stored name that predates the rules
   * should still render rather than blanking the screen it appears on. The
   * rules belong on the way in, where they can be refused with a message.
   */
  name: z.string(),
  /**
   * The Workspace's four colors (functional definition, "Container
   * hierarchy"): `color` is the saturated tint on the tab dot and the selected
   * tab, `header` is the bar across the top, `bar` is the strip the dashboard
   * tabs sit on one step lighter than it, and `ground` is the page behind the
   * panels. They are chosen together, from the fixed palette in
   * domain/workspace-themes.ts.
   *
   * All four are stored, rather than the name of a theme: the palette is then
   * a picker rather than a storage format, so letting somebody mix their own
   * colors later is a second writer of the same four fields rather than a
   * migration.
   *
   * Deliberately the permissive `z.string()` and not `hexColorSchema`, for the
   * reason `name` above is permissive: this is the shape read back, and a
   * stored color that predates the rules should still render rather than
   * blanking the screen it appears on. The rules belong on the way in.
   */
  color: z.string(),
  bar: z.string(),
  ground: z.string(),
  header: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/**
 * A Dashboard's name obeys exactly the rules a Workspace's does, by being the
 * same schema rather than a copy of it: required, trimmed, single-line, at most
 * 60 characters. What differs is only the scope uniqueness is decided in - the
 * workspace rather than the account - and that is not a shape, so it is not
 * here ("Add and switch dashboards", issue 32).
 */
export const dashboardNameSchema = workspaceNameSchema;

/**
 * A Dashboard: a named view inside a Workspace, which you switch between like
 * tabs (functional definition, "Container hierarchy"). It holds Panels once
 * "Panels on a dashboard, with per-screen-size layouts" (issue 33) lands.
 *
 * `name` and `id` are the permissive `z.string()` for the reason a Workspace's
 * are: this is the shape read back, and a stored name that predates the rules
 * should still render rather than blanking the bar it appears in. The ids of
 * the dashboards every workspace was given when this landed are derived from
 * their workspace's own id, so they are not all uuids either.
 */
export const dashboardSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
