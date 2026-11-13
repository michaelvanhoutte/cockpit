import { mostUsedPanelsSchema, type MostUsedPanels } from '@cockpit/shared';
import { api, refusal } from './client';

/**
 * The Panels Items landed on this week, account-wide, with their 24-hour and
 * 7-day counts ("Capture: offer today's and this week's most-used Panels…",
 * issue 1743): what Capture's buttons under *File on* are ranked from
 * (`mostUsedPanels.ts`).
 */
export async function fetchMostUsedPanels(): Promise<MostUsedPanels> {
  const res = await api.v1['most-used-panels'].$get();
  if (!res.ok) throw refusal('most-used panels', res.status);
  return mostUsedPanelsSchema.parse(await res.json());
}

/**
 * Read each time Capture opens and kept like any other saved read
 * (`savedReads.ts`), so the last answer draws at once and offline while the
 * next is on its way. Never waited on: the note box draws without it.
 */
export const mostUsedPanelsQuery = {
  queryKey: ['mostUsedPanels'],
  queryFn: fetchMostUsedPanels,
  staleTime: 0,
  retry: false,
} as const;
