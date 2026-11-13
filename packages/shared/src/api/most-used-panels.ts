import { z } from 'zod';

/**
 * The Panels Items landed on this week, account-wide ("Capture: offer today's
 * and this week's most-used Panels…", issue 1743): what Capture ranks its
 * buttons under *File on* from, for whatever *Where* holds.
 *
 * One entry per live Panel that a person filed an Item on in the last 7 days,
 * by the store's clock, and that Item still on it and not dismissed; a finished
 * Item still counts. Counted once per Item per Panel.
 */
export const mostUsedPanelSchema = z.object({
  panelId: z.string(),
  panelName: z.string(),
  dashboardName: z.string(),
  workspaceId: z.string(),
  /** Items that landed on it in the last 24 hours. */
  lastDay: z.number().int().nonnegative(),
  /** Items that landed on it in the last 7 days, those of the last 24 hours included. */
  lastWeek: z.number().int().positive(),
  /** When the latest of them landed, which breaks a tie. */
  lastFiledAt: z.iso.datetime(),
});
export type MostUsedPanel = z.infer<typeof mostUsedPanelSchema>;

export const mostUsedPanelsSchema = z.object({
  panels: z.array(mostUsedPanelSchema),
});
export type MostUsedPanels = z.infer<typeof mostUsedPanelsSchema>;
