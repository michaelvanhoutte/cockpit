import { describe, expect, it } from 'vitest';
import { GmailWorld, signedInHost } from './gmail-world.js';

/**
 * L1, against a faked Gmail: a conversation's user labels are what the
 * connector reports as its Item's names, on arrival and whenever they change
 * ("File Gmail conversations on the Panel named after their label", issue
 * 1148). What the host files by them is the host's, and is proved there.
 */

describe('Connector management', () => {
  describe('Gmail reports a conversation’s user labels, over all its messages, as its names', () => {
    it.each([
      {
        situation: 'one message labelled Customer Atlas',
        choice: 'label',
        labels: ['Customer Atlas'],
        reports: ['Customer Atlas'],
      },
      {
        situation: 'two labels on one message',
        choice: 'label',
        labels: ['Customer Atlas', 'Admin'],
        reports: ['Customer Atlas', 'Admin'],
      },
      {
        situation: 'a nested label, by its full name',
        choice: 'label',
        labels: ['Clients/Atlas'],
        reports: ['Clients/Atlas'],
      },
      {
        situation: 'only Gmail’s own labels (inbox, unread, a category tab)',
        choice: 'label',
        labels: [],
        reports: [],
      },
      {
        situation: 'the followed star, where the Cockpit label is a label like any other',
        choice: 'star',
        labels: ['Cockpit', 'Admin'],
        reports: ['Cockpit', 'Admin'],
      },
    ])('$situation', async ({ choice, labels, reports }) => {
      const world = new GmailWorld();
      const first = signedInHost({ choice });
      await world.connector().sync(first);
      world.arrives('t-1', 'Quarterly figures', undefined, [choice === 'star' ? 'star' : 'label']);
      for (const name of labels) world.label('t-1', name);

      const second = first.next();
      await world.connector().sync(second);

      expect(second.filed.get('t-1')?.names).toEqual(reports);
    });

    it('never reports the Cockpit label the connection follows', async () => {
      const world = new GmailWorld();
      const first = signedInHost();
      await world.connector().sync(first);
      world.arrives('t-1', 'Quarterly figures');
      world.label('t-1', 'Customer Atlas');

      const second = first.next();
      await world.connector().sync(second);

      expect(second.filed.get('t-1')?.names).not.toContain('Cockpit');
    });

    it('counts a label on any message of the conversation', async () => {
      const world = new GmailWorld();
      const first = signedInHost();
      await world.connector().sync(first);
      world.arrives('t-1', 'Quarterly figures');
      world.label('t-1', 'Customer Atlas');
      world.replies('t-1', ['Admin']);

      const second = first.next();
      await world.connector().sync(second);

      expect(second.filed.get('t-1')?.names).toEqual(['Customer Atlas', 'Admin']);
    });
  });

  describe('Gmail reports the names again only when the set may have changed', () => {
    async function known(choice = 'label') {
      const world = new GmailWorld();
      const first = signedInHost({ choice });
      await world.connector().sync(first);
      world.arrives('t-1', 'Quarterly figures', undefined, [choice === 'star' ? 'star' : 'label']);
      world.label('t-1', 'Customer Atlas');
      const second = first.next();
      await world.connector().sync(second);
      return { world, host: second };
    }

    it('reports the new full set for a label added to a conversation already in', async () => {
      const { world, host } = await known();
      world.label('t-1', 'Admin');

      const next = host.next();
      await world.connector().sync(next);

      expect(next.namesReported).toEqual([{ sourceId: 't-1', names: ['Customer Atlas', 'Admin'] }]);
    });

    it('reports the new set for a label taken off', async () => {
      const { world, host } = await known();
      world.unlabel('t-1', 'Customer Atlas');

      const next = host.next();
      await world.connector().sync(next);

      expect(next.namesReported).toEqual([{ sourceId: 't-1', names: [] }]);
    });

    it('reports a renamed label by its new name once the conversation’s labels next change', async () => {
      const { world, host } = await known();
      world.rename('Customer Atlas', 'Atlas');
      world.label('t-1', 'Admin');

      const next = host.next();
      await world.connector().sync(next);

      expect(next.namesReported).toEqual([{ sourceId: 't-1', names: ['Atlas', 'Admin'] }]);
    });

    it.each([
      { situation: 'Gmail’s own label, unread, taken off', change: (world: GmailWorld) => world.unlabel('t-1', 'UNREAD') },
    ])('reports nothing for $situation', async ({ change }) => {
      const { world, host } = await known();
      change(world);

      const next = host.next();
      await world.connector().sync(next);

      expect(next.namesReported).toEqual([]);
    });

    it('reports a label put on a conversation by a connection following the star too', async () => {
      const { world, host } = await known('star');
      world.label('t-1', 'Admin');

      const next = host.next();
      await world.connector().sync(next);

      expect(next.namesReported).toEqual([{ sourceId: 't-1', names: ['Customer Atlas', 'Admin'] }]);
    });

    it('reports each conversation’s set once at a full re-read after a week unchecked', async () => {
      const { world, host } = await known();
      world.arrives('t-2', 'Lunch');
      world.label('t-2', 'Admin');
      world.forgetHistory();

      const next = host.next();
      await world.connector().sync(next);

      expect([...next.filed.values()].map((one) => [one.sourceId, one.names])).toEqual([
        ['t-1', ['Customer Atlas']],
        ['t-2', ['Admin']],
      ]);
    });
  });

  describe('Gmail’s labels cost no call a connection following the label was not making', () => {
    it('reads the list of labels once for the mark and the names together', async () => {
      const world = new GmailWorld();
      const first = signedInHost();
      await world.connector().sync(first);
      world.arrives('t-1', 'Quarterly figures');
      world.label('t-1', 'Customer Atlas');
      world.forget();

      await world.connector().sync(first.next());

      expect(world.requests.filter((one) => one.includes('/labels'))).toHaveLength(1);
    });
  });
});
