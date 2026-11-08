import { z } from 'zod';

/**
 * The draft request behind *Email…* and *Reply…* ("Email… makes a Gmail draft
 * the Item then follows", issue 1708). Its own entry point
 * (`@cockpit/shared/draft`), outside the package's index, so the app fetches it
 * with the click's chunk rather than in its initial bundle.
 */

/**
 * *Email…* or *Reply…* asking for a draft. `clickId` is the click's own id, so
 * the same click resent after a timeout answers the draft already made rather
 * than making a second. Stamped on the store's clock, not the device's.
 */
export const draftAskedSchema = z.object({
  clickId: z.uuid(),
  sourceAccountId: z.string().min(1),
});
export type DraftAsked = z.infer<typeof draftAskedSchema>;

/** Where the draft made opens at its source, for the tab opened at the click. */
export const draftMadeSchema = z.object({ link: z.string() });
export type DraftMadeAnswer = z.infer<typeof draftMadeSchema>;
