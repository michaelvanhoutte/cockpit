import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLike, giveTheWorkerTheReadToken, importTheCalls, theCallsPage } from './cockpit-support';
import { emptyTheDatabase, theSentence } from './support';

let putBack: () => void;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T12:00:00Z') });
  await emptyTheDatabase();
  putBack = giveTheWorkerTheReadToken();
  await importTheCalls([
    callLike({ id: 1, at: '2026-10-21T08:15:00Z', costUsd: 3 }),
    callLike({ id: 2, at: '2026-10-22T09:00:00Z', feature: 'choose-a-panel', model: 'claude-haiku-4-5', costUsd: 1 }),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  putBack();
});

describe('Harness Monitor', () => {
  describe("Cockpit's Claude calls says what it shows as one sentence on the band, and offers only what it can", () => {
    it('the bare address reads each day, coloured by environment, over the last 30 days, with no filter holding a value and Export CSV after them', async () => {
      const html = await theCallsPage();
      const { text, choices } = theSentence(html);

      expect(text).toBe('Show cost for [each day] coloured by [environment] over [the last 30 days]');
      expect(choices.group!.offered).toEqual(['each day', 'each feature', 'each environment', 'each pull request', 'each starter']);
      expect(choices.split!.offered).toEqual(['environment', 'feature', 'model', 'starter']);
      expect(choices.period!.offered).toEqual(['the last 7 days', 'the last 30 days', 'the last 90 days', 'all time']);
      expect(Object.keys(choices)).toEqual(['group', 'split', 'period', 'environment', 'feature', 'model']);
      expect(Object.values(choices).filter((c) => c.held)).toEqual([]);
      expect(/<div class="only"><span>Only<\/span>.*Export CSV<\/a><\/div>/s.test(html)).toBe(true);
    });

    it.each([
      { situation: 'each feature', query: 'group=feature', disabled: 'feature', gone: 'feature' },
      { situation: 'each environment', query: 'group=environment', disabled: 'environment', gone: 'environment' },
      { situation: 'each starter', query: 'group=startedBy', disabled: 'starter', gone: null },
    ])('$situation offers coloured by $disabled but not for the choosing, and no filter repeating the rows', async ({ query, disabled, gone }) => {
      const { choices } = theSentence(await theCallsPage(`?${query}`));

      expect(choices.split!.disabled).toEqual([disabled]);
      expect(choices.split!.offered).toContain(disabled);
      expect(Object.keys(choices)).toEqual(['group', 'split', 'period', ...['environment', 'feature', 'model'].filter((f) => f !== gone)]);
    });

    it('a pull request row keeps every colouring and every filter', async () => {
      const { choices } = theSentence(await theCallsPage('?group=pr&split=feature&feature=choose-a-panel'));

      expect(choices.split).toMatchObject({ chosen: 'feature', disabled: [] });
      expect(choices.feature).toMatchObject({ chosen: 'Choose a panel', held: true });
    });

    it('every word and filter is in the one form that keeps it', async () => {
      const html = await theCallsPage('?group=pr&environment=ci');

      expect(html.match(/<form /g)).toHaveLength(1);
      expect(/<form class="sentence-form".*?name="group".*?name="split".*?name="period".*?name="environment".*?<\/form>/s.test(html)).toBe(true);
    });

    it('there are no grouping tabs, no Split by toggle and no labelled filter row', async () => {
      const html = await theCallsPage('?group=pr');

      for (const gone of ['band-tabs', 'aria-label="Group by"', 'Split by', 'class="toggles"', 'class="filters"', '<label ']) expect(html).not.toContain(gone);
    });
  });
});
