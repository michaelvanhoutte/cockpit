import { z } from 'zod';

/**
 * One note added to an Item after it was captured ("Capture append: add to the
 * Item you just captured with an Add to this button", issue 1640), kept beside
 * the captured message rather than written into it, so the message stays as
 * first written and each addition keeps where it starts, where it ends and when
 * it was made. The Item's *Details* tab lists them under the captured message,
 * oldest first.
 *
 * **`createdAt` is when Capture was pressed**, not when the addition reached
 * the server, so one kept offline still sits in the order it was written.
 */
export const additionSchema = z.object({
  id: z.uuid(),
  tenantId: z.string(),
  itemId: z.uuid(),
  /** Permissive on read, for the reason every read-back field is; capped on the way in (`appendToItemSchema`). */
  message: z.string(),
  createdAt: z.iso.datetime(),
});
export type Addition = z.infer<typeof additionSchema>;

/** One Item's additions out of a Workspace's whole list, oldest first: what its *Details* tab lists. */
export function additionsOf(additions: readonly Addition[] | undefined, itemId: string): Addition[] {
  return (additions ?? [])
    .filter((addition) => addition.itemId === itemId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
