import { describe, expect, it } from 'vitest';
import type { MirroredOpenStates } from '@cockpit/connector-sdk';
import { GraphWorld, signedInHost } from './outlook-world.js';

/**
 * L1, against a fake host and Graph faked at the network: a Task done,
 * dismissed or reopened in Cockpit reaches its message's flag or category
 * before the run lists anything ("Take the flag or category off in Outlook when
 * its task is done in Cockpit", issue 1047). L1 because what is written, and
 * when, is the connector's own decision.
 */

function answered(answer: MirroredOpenStates): { confirmed: string[]; gaveUp: string[] } {
  if (Array.isArray(answer)) return { confirmed: answer, gaveUp: [] };
  return { confirmed: answer.confirmed ?? [], gaveUp: answer.gaveUp ?? [] };
}

describe('Connector management', () => {
  describe('Done or Dismiss takes the followed mark off in Outlook, and reopening puts it back, touching nothing else', () => {
    it.each([
      { situation: 'closed, following the flag', open: false, flag: 'flagged', wanted: 'complete' },
      { situation: 'opened, following the flag', open: true, flag: 'complete', wanted: 'flagged' },
    ] as const)('$situation: the flag alone is set', async (one) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: one.flag, categories: ['Red category', 'Cockpit'] });

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'flag' }), [{ sourceId: 'm-1', open: one.open }]);

      expect(answered(answer)).toEqual({ confirmed: ['m-1'], gaveUp: [] });
      expect(world.flagOf('m-1')).toBe(one.wanted);
      expect(world.categoriesOf('m-1')).toEqual(['Red category', 'Cockpit']);
      expect(world.writes.map((write) => write.body)).toEqual([{ flag: { flagStatus: one.wanted } }]);
    });

    it.each([
      { situation: 'closed, among other categories', open: false, holds: ['Red category', 'cockpit', 'Blue category'], wanted: ['Red category', 'Blue category'] },
      { situation: 'opened, among other categories', open: true, holds: ['Red category', 'Blue category'], wanted: ['Red category', 'Blue category', 'Cockpit'] },
    ] as const)('$situation, following the category: Cockpit alone changes', async (one) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', categories: one.holds });

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'category' }), [{ sourceId: 'm-1', open: one.open }]);

      expect(answered(answer)).toEqual({ confirmed: ['m-1'], gaveUp: [] });
      expect(world.categoriesOf('m-1')).toEqual(one.wanted);
      expect(world.flagOf('m-1')).toBe('flagged');
      expect(world.writes.map((write) => write.body)).toEqual([{ categories: one.wanted }]);
    });

    it.each([
      { situation: 'opened where the category is already there', open: true, holds: ['Cockpit'] },
      { situation: 'closed where the category is not there', open: false, holds: ['Red category'] },
    ])('$situation: nothing is written, and it is confirmed', async (one) => {
      const world = new GraphWorld();
      world.arrives('m-1', { categories: one.holds });

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'category' }), [{ sourceId: 'm-1', open: one.open }]);

      expect(answered(answer)).toEqual({ confirmed: ['m-1'], gaveUp: [] });
      expect(world.writes).toEqual([]);
      expect(world.categoriesOf('m-1')).toEqual(one.holds);
    });
  });

  describe('a category written back is conditional on the version read, so a change the person makes meanwhile is kept', () => {
    it('reads the message again after the person changed it, and writes it with their change kept', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { categories: ['Cockpit', 'Red category'] });
      let once = true;
      world.beforeWrite = (id) => {
        if (once) world.categorise(id, 'Green category');
        once = false;
      };

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'category' }), [{ sourceId: 'm-1', open: false }]);

      expect(answered(answer)).toEqual({ confirmed: ['m-1'], gaveUp: [] });
      expect(world.categoriesOf('m-1')).toEqual(['Red category', 'Green category']);
      expect(world.writes).toHaveLength(2);
      expect(world.writes.every((write) => write.ifMatch !== null)).toBe(true);
    });

    it('hands the change back next run, neither confirmed nor given up, when the message keeps changing past the retry limit', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { categories: ['Cockpit'] });
      world.arrives('m-2', { categories: ['Cockpit'] });
      world.beforeWrite = (id) => {
        if (id === 'm-1') world.categorise(id, `Category ${world.writes.length}`);
      };

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: 'category' }), [
        { sourceId: 'm-1', open: false },
        { sourceId: 'm-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['m-2'], gaveUp: [] });
      expect(world.categoriesOf('m-1')).toContain('Cockpit');
    });
  });

  describe('open states are pushed before the listing is read', () => {
    it('lets the listing agree with a Task closed in Cockpit whose message was still flagged, so nothing reopens', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.arrives('m-2', { flag: 'flagged' });
      const first = signedInHost();
      await world.connector().sync(first);

      const second = first.next();
      const connector = world.connector();
      const answer = await connector.mirrorOpenState!(second, [{ sourceId: 'm-1', open: false }]);
      await connector.sync(second);

      // What has the host push before every run.
      expect(connector.manifest.mirrorsOpenState).toBe(true);
      expect(answered(answer).confirmed).toEqual(['m-1']);
      expect(world.flagOf('m-1')).toBe('complete');
      expect(second.listings).toEqual([{ choice: 'flag', sourceIds: ['m-2'] }]);
      expect(second.saidOf('m-1')).toEqual([]);
    });
  });

  describe('a message that is gone counts as done, Microsoft holding back waits, and any other refusal is given up', () => {
    it.each([
      { situation: 'following the flag', choice: 'flag' },
      { situation: 'following the category', choice: 'category' },
    ])('confirms a message that is gone, $situation', async ({ choice }) => {
      const world = new GraphWorld();

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice }), [{ sourceId: 'vanished', open: false }]);

      expect(answered(answer)).toEqual({ confirmed: ['vanished'], gaveUp: [] });
    });

    it.each([
      { situation: 'a rate limit', status: 429 },
      { situation: 'Microsoft unavailable', status: 503 },
      { situation: 'Microsoft failing', status: 500 },
    ])('hands every change back next run on $situation, the rest waiting too', async ({ status }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.arrives('m-2', { flag: 'flagged' });
      world.failures.push({ prefix: 'messages/m-1', status });
      const host = signedInHost();

      const answer = await world.connector().mirrorOpenState!(host, [
        { sourceId: 'm-1', open: false },
        { sourceId: 'm-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: [], gaveUp: [] });
      expect(world.flagOf('m-2')).toBe('flagged');
    });

    it.each([
      { situation: 'following the flag', choice: 'flag' },
      { situation: 'following the category', choice: 'category' },
    ])('gives up on a message Microsoft refuses access to, and still pushes the next, $situation', async ({ choice }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', categories: ['Cockpit'] });
      world.arrives('m-2', { flag: 'flagged', categories: ['Cockpit'] });
      world.failures.push({ prefix: 'messages/m-1', status: 403, body: { error: { code: 'ErrorAccessDenied' } } });
      const host = signedInHost({ choice });

      const answer = await world.connector().mirrorOpenState!(host, [
        { sourceId: 'm-1', open: false },
        { sourceId: 'm-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['m-2'], gaveUp: ['m-1'] });
      expect(host.logged.some((one) => one.level === 'warn')).toBe(true);
    });

    it('refreshes a sign-in Graph stopped accepting once, and writes the change', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.failures.push({ prefix: 'messages/m-1', status: 401 });
      const host = signedInHost();

      const answer = await world.connector().mirrorOpenState!(host, [{ sourceId: 'm-1', open: false }]);

      expect(answered(answer)).toEqual({ confirmed: ['m-1'], gaveUp: [] });
      expect(host.credentialsSaved).toHaveLength(1);
      expect(world.flagOf('m-1')).toBe('complete');
    });
  });

  describe('changes pushed share the run’s calls with the listing', () => {
    it('pushes as many as the calls allow, hands the rest back, and says there is more to do', async () => {
      const world = new GraphWorld();
      const ids = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'];
      for (const id of ids) world.arrives(id, { flag: 'flagged' });
      const connector = world.connector({ callsPerRun: 3 });
      const host = signedInHost();

      const answer = await connector.mirrorOpenState!(host, ids.map((sourceId) => ({ sourceId, open: false })));
      const run = await connector.sync(host);

      expect(answered(answer)).toEqual({ confirmed: ['m-1', 'm-2', 'm-3'], gaveUp: [] });
      expect(run).toEqual({ moreToDo: true });
      expect(world.graphCalls()).toBe(3);
      expect(host.listings).toEqual([]);
    });
  });
});
