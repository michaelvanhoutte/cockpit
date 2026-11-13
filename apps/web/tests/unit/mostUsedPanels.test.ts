import { describe, expect, it } from 'vitest';
import type { MostUsedPanel } from '@cockpit/shared';
import { panelsToOffer } from '../../src/mostUsedPanels';

/**
 * L1: which Panels Capture offers under *File on* is a calculation on the
 * account's most-used answer and the Workspace *Where* holds. What the answer
 * counts is apps/api/tests/integration/http/most-used-panels.test.ts; the
 * buttons themselves are components/CaptureNote.test.tsx.
 */

const WORK = 'ws-work';

/** A Panel of Work used `day` times in the last 24 hours and `week` in the last 7 days, last filed `hoursAgo` hours before noon. */
const used = (name: string, day: number, week: number, hoursAgo = 1, workspaceId = WORK): MostUsedPanel => ({
  panelId: `p-${name}`,
  panelName: name,
  dashboardName: 'Board',
  workspaceId,
  lastDay: day,
  lastWeek: week,
  lastFiledAt: new Date(Date.UTC(2026, 10, 13, 12 - hoursAgo)).toISOString(),
});

describe('Capture', () => {
  describe('File on offers the Panel most used today, then the week’s most used, three at most, of Where’s Workspace', () => {
    it.each([
      {
        situation: 'the 24-hour leader is not among the week’s top two',
        answer: [used('A', 0, 9), used('B', 0, 8), used('C', 3, 4)],
        offered: ['C', 'A', 'B'],
      },
      {
        situation: 'the 24-hour leader is also the week’s',
        answer: [used('A', 3, 9), used('B', 0, 8), used('C', 1, 4), used('D', 0, 2)],
        offered: ['A', 'B', 'C'],
      },
      {
        situation: 'two Panels tie, the one filed onto more recently first',
        answer: [used('Older', 0, 5, 30), used('Newer', 0, 5, 10), used('C', 0, 1)],
        offered: ['Newer', 'Older', 'C'],
      },
      {
        situation: 'nothing landed in the last 24 hours',
        answer: [used('A', 0, 2), used('B', 0, 7), used('C', 0, 5), used('D', 0, 1)],
        offered: ['B', 'C', 'A'],
      },
      { situation: 'two Panels were used this week', answer: [used('A', 0, 2), used('B', 1, 1)], offered: ['B', 'A'] },
      { situation: 'none was used this week', answer: [], offered: [] },
      {
        situation: 'Panels of another Workspace were used more',
        answer: [used('Home', 4, 9, 1, 'ws-home'), used('A', 0, 1)],
        offered: ['A'],
      },
    ])('when $situation', ({ answer, offered }) => {
      expect(panelsToOffer(answer, WORK).map((panel) => panel.panelName)).toEqual(offered);
    });
  });

  describe('File on under Any workspace ranks the Panels of every Workspace together', () => {
    it.each([
      {
        situation: 'the leaders are spread over two Workspaces',
        answer: [used('A', 0, 9), used('Home', 4, 5, 1, 'ws-home'), used('B', 0, 8), used('C', 0, 7)],
        offered: ['Home', 'A', 'B'],
      },
      {
        situation: 'two Panels of one name are in different Workspaces',
        answer: [used('Tasks', 0, 5), used('Tasks', 0, 4, 1, 'ws-home')].map((panel, at) => ({ ...panel, panelId: `p-tasks-${at}` })),
        offered: ['Tasks', 'Tasks'],
      },
    ])('when $situation', ({ answer, offered }) => {
      expect(panelsToOffer(answer, null).map((panel) => panel.panelName)).toEqual(offered);
    });
  });
});
