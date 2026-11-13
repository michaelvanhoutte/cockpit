import type { MostUsedPanel } from '@cockpit/shared';

/** How many buttons Capture offers under *File on*. */
export const MOST_USED_OFFERED = 3;

/** Which of two Panels ranks first by `count`: the higher count, then the one filed onto more recently. */
function byCount(count: (panel: MostUsedPanel) => number) {
  return (a: MostUsedPanel, b: MostUsedPanel) =>
    count(b) - count(a) || (a.lastFiledAt < b.lastFiledAt ? 1 : a.lastFiledAt > b.lastFiledAt ? -1 : 0);
}

/**
 * The Panels Capture offers as buttons under *File on* ("Capture: offer
 * today's and this week's most-used Panels…", issue 1743): of `where`'s
 * Workspace, first the one most Items landed on in the last 24 hours, then the
 * week's most used, skipping that one, until there are three. Ties go to the
 * Panel filed onto most recently. None this week, none offered.
 */
export function panelsToOffer(used: readonly MostUsedPanel[], where: string): MostUsedPanel[] {
  const here = used.filter((panel) => panel.workspaceId === where && panel.lastWeek > 0);
  const today = here.filter((panel) => panel.lastDay > 0).sort(byCount((panel) => panel.lastDay))[0];
  const week = here.sort(byCount((panel) => panel.lastWeek)).filter((panel) => panel !== today);
  return [...(today ? [today] : []), ...week].slice(0, MOST_USED_OFFERED);
}
