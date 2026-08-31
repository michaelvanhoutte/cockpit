import { z } from 'zod';

/**
 * The Item + Association model (functional definition §4.2).
 * These are the wire shapes shared by the API and the client; the database
 * schema in apps/api mirrors them with snake_case columns.
 */

/** Where an Item came from. 'internal' means created inside Cockpit. */
export const sourceSchema = z.enum(['internal', 'mail', 'slack', 'notion', 'whatsapp']);
export type Source = z.infer<typeof sourceSchema>;

/** Processing status (functional definition §5). */
export const itemStatusSchema = z.enum([
  'to_process',
  'task',
  'waiting',
  'snoozed',
  'delegated',
  'reference',
  'done',
  'dismissed',
]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

/** Focus horizons (functional definition §7). */
export const focusHorizonSchema = z.enum(['today', 'week', 'month', 'quarter']);
export type FocusHorizon = z.infer<typeof focusHorizonSchema>;

export const prioritySchema = z.enum(['low', 'normal', 'high']);
export type Priority = z.infer<typeof prioritySchema>;

/**
 * Source-owned vs app-owned fields are kept in separate groups (architecture §4.2):
 * a connector re-sync overwrites the source-owned group unconditionally and never
 * touches the app-owned group.
 */
export const itemSchema = z.object({
  id: z.uuid(),
  tenantId: z.string(),
  workspaceId: z.string(),

  // -- source-owned --
  source: sourceSchema,
  sourceId: z.string().nullable(),
  sourceLink: z.url().nullable(),
  sender: z.string().nullable(),
  sourceTimestamp: z.iso.datetime().nullable(),
  title: z.string(),
  preview: z.string().nullable(),
  /** Tombstone written by reconciliation when the source resolved/removed it. */
  sourceResolvedAt: z.iso.datetime().nullable(),

  // -- app-owned --
  status: itemStatusSchema,
  /** The current, always-editable next-action label (functional definition §6.1). */
  nextAction: z.string().nullable(),
  focusHorizon: focusHorizonSchema.nullable(),
  priority: prioritySchema.nullable(),
  dueDate: z.iso.date().nullable(),
  snoozedUntil: z.iso.datetime().nullable(),
  unseen: z.boolean(),
  /** Tombstone, never a hard delete (architecture §4.2). */
  deletedAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Item = z.infer<typeof itemSchema>;

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
   * `\p{Cc}` only: the C0 and C1 control characters. Not `\p{Cf}`, which would
   * take the zero-width joiner with it and refuse half the emoji anybody would
   * put in a name.
   */
  .refine((name) => !/\p{Cc}/u.test(name), {
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
   * Workspace color identity (functional definition, "Container hierarchy").
   * Assigned from a fixed palette when the workspace is created; choosing it
   * yourself is "Choose a workspace's colors from a palette" (issue 79).
   */
  color: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
