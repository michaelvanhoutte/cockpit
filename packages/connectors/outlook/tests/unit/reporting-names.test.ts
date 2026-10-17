import { describe, expect, it } from 'vitest';
import { NAMES_REPORTED_PER_RUN } from '../../src/sync.js';
import { GraphWorld, signedInHost } from './outlook-world.js';

/**
 * L1, against a faked Graph: a message's categories are what the connector
 * reports as its Item's names, on arrival and whenever they change ("File
 * Outlook mail on the Panel named after its category", issue 1146). What the
 * host files by them is the host's, and is proved there.
 */

describe('Connector management', () => {
  describe('Outlook reports a message’s categories as its names', () => {
    it.each([
      {
        situation: 'a message arriving with Customer Atlas and Cockpit while the connection follows the category',
        choice: 'category',
        categories: ['Customer Atlas', 'Cockpit'],
        flag: undefined,
        reports: ['Customer Atlas'],
      },
      {
        situation: 'a message arriving while the connection follows the flag',
        choice: 'flag',
        categories: ['Customer Atlas', 'Cockpit'],
        flag: 'flagged' as const,
        reports: ['Customer Atlas', 'Cockpit'],
      },
    ])('$situation', async ({ choice, categories, flag, reports }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { categories, ...(flag ? { flag } : {}) });
      const host = signedInHost({ choice });

      await world.connector().sync(host);

      expect(host.filed.get('m-1')?.names).toEqual(reports);
    });

    it.each([
      { situation: 'a category added before a later re-read reports the new whole set', adds: ['Admin'], reports: [{ sourceId: 'm-1', names: ['Customer Atlas', 'Admin'] }] },
      { situation: 'categories unchanged at a re-read report nothing', adds: [], reports: [] },
    ])('$situation', async ({ adds, reports }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', categories: ['Customer Atlas'] });
      const first = signedInHost();
      await world.connector().sync(first);
      if (adds.length > 0) world.categorise('m-1', ...adds);

      const second = first.next();
      await world.connector().sync(second);

      expect(second.namesReported).toEqual(reports);
    });

    it.each([
      { situation: 'following the category, says the mark it left out of the names', choice: 'category', flag: undefined, followed: 'Cockpit' },
      { situation: 'following the flag, says no mark was left out', choice: 'flag', flag: 'flagged' as const, followed: undefined },
    ])('$situation, on arrival and at a re-read (issue 1197)', async ({ choice, flag, followed }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { categories: ['Customer Atlas', 'Cockpit'], ...(flag ? { flag } : {}) });
      const first = signedInHost({ choice });
      await world.connector().sync(first);
      world.categorise('m-1', 'Admin');

      const second = first.next();
      await world.connector().sync(second);

      expect([first.filed.get('m-1')?.followed, second.namesReported[0]?.followed]).toEqual([followed, followed]);
    });

    it('reports at most its share of messages already in per run, and the rest at the next', async () => {
      const world = new GraphWorld();
      const ids = Array.from({ length: NAMES_REPORTED_PER_RUN + 1 }, (_, at) => `m-${at}`);
      for (const id of ids) world.arrives(id, { flag: 'flagged', categories: ['Customer Atlas'] });
      const first = signedInHost();
      // Every message already in from before names were reported, so none has names kept.
      first.state = { choice: 'flag', seen: ids };

      const answer = await world.connector().sync(first);
      const second = first.next();
      await world.connector().sync(second);

      expect({ answer, first: first.namesReported.length, second: second.namesReported.length }).toEqual({
        answer: { moreToDo: true },
        first: NAMES_REPORTED_PER_RUN,
        second: 1,
      });
    });
  });
});
