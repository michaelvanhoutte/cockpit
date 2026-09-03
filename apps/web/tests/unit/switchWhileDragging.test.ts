import { describe, expect, it } from 'vitest';
import { DWELL_MS, dashboardToSwitchTo } from '../../src/switchWhileDragging';

/**
 * F1, and this is where the rule lives rather than in the handler that uses it:
 * jsdom performs no drag, so a test driving drag events against it would be
 * measuring nothing. That a person can actually reach a dashboard they are not
 * on is tests/e2e/filing.test.ts.
 *
 * The scrolling half of the same issue has no rules here, because it needed no
 * code: the browser scrolls the container under a drag by itself.
 */

describe('Panels', () => {
  describe('a drag resting on a dashboard’s name switches to it', () => {
    const NOW = 1_000_000;

    it.each([
      {
        situation: 'rested the full dwell',
        resting: { dashboardId: 'research', since: NOW - DWELL_MS },
        open: 'today',
        switchesTo: 'research',
      },
      {
        situation: 'left before the dwell was up',
        resting: null,
        open: 'today',
        switchesTo: null,
      },
      {
        situation: 'still resting, but not for long enough',
        resting: { dashboardId: 'research', since: NOW - DWELL_MS + 1 },
        open: 'today',
        switchesTo: null,
      },
      {
        situation: 'resting on the dashboard already open',
        resting: { dashboardId: 'today', since: NOW - DWELL_MS * 3 },
        open: 'today',
        switchesTo: null,
      },
      {
        situation: 'resting while no dashboard is open, as on the Inbox screen',
        resting: { dashboardId: 'research', since: NOW - DWELL_MS },
        open: null,
        switchesTo: 'research',
      },
    ])('$situation', ({ resting, open, switchesTo }) => {
      expect(dashboardToSwitchTo(resting, NOW, open)).toBe(switchesTo);
    });

    it('starts the dwell over when a name is left and rested on again', () => {
      // Leaving clears what is being rested on, so the second rest is timed
      // from when it began rather than from the first one.
      const first = { dashboardId: 'research', since: NOW - DWELL_MS + 100 };
      expect(dashboardToSwitchTo(first, NOW, 'today')).toBeNull();

      const again = { dashboardId: 'research', since: NOW };
      expect(dashboardToSwitchTo(again, NOW + DWELL_MS - 1, 'today')).toBeNull();
      expect(dashboardToSwitchTo(again, NOW + DWELL_MS, 'today')).toBe('research');
    });
  });
});
