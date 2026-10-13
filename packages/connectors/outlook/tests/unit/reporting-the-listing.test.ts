import { describe, expect, it } from 'vitest';
import { DELETED_ITEMS_ID, GraphWorld, signedInHost } from './outlook-world.js';

/**
 * L1: a listing of the marked messages is reported complete under the choice,
 * so the host closes the Items of messages that lost the mark - and one that
 * did not finish is never reported, since an empty listing would read as
 * "nothing is marked any more" ("Build Outlook as a connector package on the
 * SDK, unregistered", issue 1046).
 */

describe('Capture', () => {
  describe('a complete listing is reported under the choice, and an incomplete one never is', () => {
    it('reports one listing holding every id of a listing over several pages, under the choice of the run', async () => {
      const world = new GraphWorld();
      world.pageSize = 2;
      for (const id of ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']) world.arrives(id, { flag: 'flagged' });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(world.listPages()).toBe(3);
      expect(host.listings).toHaveLength(1);
      expect(host.listings[0]!.choice).toBe('flag');
      expect([...host.listings[0]!.sourceIds].sort()).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5']);
    });

    it('reports nothing and keeps nothing when a page fails part-way through the listing', async () => {
      const world = new GraphWorld();
      world.pageSize = 2;
      for (const id of ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']) world.arrives(id, { flag: 'flagged' });
      world.failures.push({ prefix: 'v1.0/me/messages', status: 500, after: 1 });
      const host = signedInHost();

      await expect(world.connector().sync(host)).resolves.toBeUndefined();

      expect(host.listings).toEqual([]);
      expect(host.state).toBeNull();
      expect(host.filed.size).toBe(0);
    });

    it('never sends the sign-in to a next page named somewhere other than Microsoft Graph', async () => {
      const world = new GraphWorld();
      world.pageSize = 1;
      world.nextLinkOrigin = 'https://elsewhere.example.test';
      world.arrives('m-1', { flag: 'flagged' });
      world.arrives('m-2', { flag: 'flagged' });
      const host = signedInHost();

      await expect(world.connector().sync(host)).resolves.toBeUndefined();

      expect(world.requests.some((one) => one.includes('elsewhere'))).toBe(false);
      expect(host.listings).toEqual([]);
    });

    it('reports an empty listing for a mailbox with nothing marked', async () => {
      const world = new GraphWorld();
      world.arrives('m-1');
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.listings).toEqual([{ choice: 'flag', sourceIds: [] }]);
    });

    it('leaves out a message moved to Deleted Items since the last run', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.arrives('m-2', { flag: 'flagged' });
      const first = signedInHost();
      await world.connector().sync(first);
      world.moveTo('m-1', DELETED_ITEMS_ID);
      world.listsEverything = true;

      const second = first.next();
      await world.connector().sync(second);

      expect(second.listings).toEqual([{ choice: 'flag', sourceIds: ['m-2'] }]);
    });
  });

  describe('Microsoft holding the mailbox back ends the run quietly', () => {
    it.each([429, 503])('ends the run without reporting or failing the connection when a listing page is answered %s', async (status) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.failures.push({ prefix: 'v1.0/me/messages', status });
      const host = signedInHost();

      await expect(world.connector().sync(host)).resolves.toBeUndefined();

      expect(host.listings).toEqual([]);
      expect(host.state).toBeNull();
      expect(host.logged.map((one) => one.level)).toEqual(['warn']);
    });

    it('keeps what it had brought in when holding back comes while reading, and reads the rest next run', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      world.arrives('m-2', { flag: 'flagged' });
      world.failures.push({ prefix: 'v1.0/me/messages/', status: 429, after: 1 });
      const first = signedInHost();

      await expect(world.connector().sync(first)).resolves.toBeUndefined();
      expect(first.filed.size).toBe(1);
      world.forget();

      const second = first.next();
      await world.connector().sync(second);

      expect(world.readsInFull()).toHaveLength(1);
      expect(second.filed.size).toBe(2);
    });
  });
});
