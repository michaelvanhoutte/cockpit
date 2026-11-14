import { describe, expect, it } from 'vitest';
import { GraphWorld, signedInHost } from './outlook-world.js';

/**
 * L1, against a fake host and Microsoft Graph faked at the network: the day a
 * flag is due is what the connector offers as its Item's due day, and what it
 * reports when the day changes ("A flag's date becomes the Outlook Item's due
 * date", issue 1759). What the host does with a day is the host's, proved in
 * apps/api/tests/integration/connectors/due-date-from-the-source.test.ts.
 *
 * The date is read in the shape Graph documents for `followupFlag.dueDateTime`
 * (a `dateTimeTimeZone`, midnight of the day chosen); that a real mailbox
 * answers so is not observed (package README, "Not yet known").
 */

const DAY = '2026-11-20';
const at = (day: string) => ({ dateTime: `${day}T00:00:00.0000000`, timeZone: 'UTC' });

describe('Capture', () => {
  describe('a conversation brought in by a dated flag is offered with the flag’s day', () => {
    it.each([
      { situation: 'midnight in the flag’s own zone', due: { dateTime: '2026-11-20T00:00:00.0000000', timeZone: 'Romance Standard Time' }, day: '2026-11-20' },
      { situation: 'midnight UTC', due: at(DAY), day: '2026-11-20' },
      { situation: 'a time late in the day, which is still that day', due: { dateTime: '2026-11-20T23:30:00.0000000', timeZone: 'UTC' }, day: '2026-11-20' },
      { situation: 'a date that is not a day', due: { dateTime: '2026-02-30T00:00:00.0000000', timeZone: 'UTC' }, day: undefined },
      { situation: 'a month that does not exist', due: { dateTime: '2026-13-01T00:00:00.0000000', timeZone: 'UTC' }, day: undefined },
      { situation: 'text that is not a date', due: { dateTime: 'tomorrow', timeZone: 'UTC' }, day: undefined },
    ])('reads $situation', async ({ due, day }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1', flagDue: due });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.get('conversation:c-1')?.dueDay).toBe(day);
    });

    it('offers no day for a plain flag', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.get('conversation:c-1')?.dueDay).toBeUndefined();
    });

    it('offers the earliest day of two flagged messages in one conversation', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1', flagDue: at(DAY) });
      world.arrives('m-2', { flag: 'flagged', conversation: 'c-1', flagDue: at('2026-11-17') });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.get('conversation:c-1')?.dueDay).toBe('2026-11-17');
    });

    it('offers no day on a connection following the category, though the message also carries a dated flag', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', categories: ['Cockpit'], flagDue: at(DAY) });
      const host = signedInHost({ choice: 'category' });

      await world.connector().sync(host);

      expect(host.filed.get('m-1')?.dueDay).toBeUndefined();
      expect(host.daysReported).toEqual([]);
    });

    it('takes the day from a flagged message on the second page of the listing', async () => {
      const world = new GraphWorld();
      world.pageSize = 1;
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });
      world.arrives('m-2', { flag: 'flagged', conversation: 'c-1', flagDue: at(DAY) });
      const host = signedInHost();

      await world.connector().sync(host);

      expect(host.filed.get('conversation:c-1')?.dueDay).toBe(DAY);
    });
  });

  describe('a changed flag day is reported, and only that', () => {
    async function broughtIn(due?: string) {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1', ...(due ? { flagDue: at(due) } : {}) });
      const host = signedInHost();
      await world.connector().sync(host);
      return { world, host };
    }

    it('reports nothing for the day it was brought in with, at the next run', async () => {
      const { world, host } = await broughtIn(DAY);

      const next = host.next();
      await world.connector().sync(next);

      expect(host.daysReported).toEqual([]);
      expect(next.daysReported).toEqual([]);
    });

    it('reports the new day where the flag moved to another', async () => {
      const { world, host } = await broughtIn(DAY);
      world.dueOn('m-1', '2026-11-24');

      const next = host.next();
      await world.connector().sync(next);

      expect(next.daysReported).toEqual([{ sourceId: 'conversation:c-1', dueDay: '2026-11-24' }]);
    });

    it('reports a day given to a flag that had none', async () => {
      const { world, host } = await broughtIn();
      world.dueOn('m-1', DAY);

      const next = host.next();
      await world.connector().sync(next);

      expect(next.daysReported).toEqual([{ sourceId: 'conversation:c-1', dueDay: DAY }]);
    });

    it('reports nothing where the flag’s date was removed, and nothing when the same day is put back', async () => {
      const { world, host } = await broughtIn(DAY);
      world.dueOn('m-1', null);
      const removed = host.next();
      await world.connector().sync(removed);
      world.dueOn('m-1', DAY);

      const back = removed.next();
      await world.connector().sync(back);

      expect([removed.daysReported, back.daysReported]).toEqual([[], []]);
    });

    it('reports the earliest day when a second flagged message with an earlier day is read later', async () => {
      const { world, host } = await broughtIn(DAY);
      world.arrives('m-2', { flag: 'flagged', conversation: 'c-1', flagDue: at('2026-11-17') });
      const second = host.next();
      await world.connector().sync(second);

      const third = second.next();
      await world.connector().sync(third);

      expect([...second.daysReported, ...third.daysReported]).toEqual([{ sourceId: 'conversation:c-1', dueDay: '2026-11-17' }]);
    });

    it('reports the day again at the next run where the report failed', async () => {
      const { world, host } = await broughtIn(DAY);
      world.dueOn('m-1', '2026-11-24');
      const failing = host.next();
      failing.failTheNextDueReport = true;
      await expect(world.connector().sync(failing)).rejects.toThrow('the host could not take the report');

      const next = host.next();
      await world.connector().sync(next);

      expect(failing.daysReported).toEqual([]);
      expect(next.daysReported).toEqual([{ sourceId: 'conversation:c-1', dueDay: '2026-11-24' }]);
    });

    it('takes the day of a conversation already in as where it starts, reports nothing, and reports a change after', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1', flagDue: at(DAY) });
      const host = signedInHost();
      host.state = { choice: 'flag', seen: ['m-1'] };

      await world.connector().sync(host);
      world.dueOn('m-1', '2026-11-24');
      const next = host.next();
      await world.connector().sync(next);

      expect(host.daysReported).toEqual([]);
      expect(next.daysReported).toEqual([{ sourceId: 'm-1', dueDay: '2026-11-24' }]);
    });

    it('reports a day given later to a conversation already in that had none', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged', conversation: 'c-1' });
      const host = signedInHost();
      host.state = { choice: 'flag', seen: ['m-1'] };
      await world.connector().sync(host);
      world.dueOn('m-1', DAY);

      const next = host.next();
      await world.connector().sync(next);

      expect(next.daysReported).toEqual([{ sourceId: 'm-1', dueDay: DAY }]);
    });

    it('reports the day with a reopen, as a flag put back after Done is brought in again', async () => {
      const { world, host } = await broughtIn();
      world.unflag('m-1');
      const gone = host.next();
      await world.connector().sync(gone);
      // Done, the Item no longer follows its conversation.
      gone.following.clear();
      world.flag('m-1');
      world.dueOn('m-1', DAY);

      const back = gone.next();
      await world.connector().sync(back);

      expect(back.saidOf('conversation:c-1')).toEqual(['reopened']);
      expect(back.daysReported).toEqual([{ sourceId: 'conversation:c-1', dueDay: DAY }]);
    });
  });
});
