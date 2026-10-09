import { describe, expect, it } from 'vitest';
import type { MirroredOpenStates } from '@cockpit/connector-sdk';
import { CALLS_PER_RUN } from '../../src/index.js';
import { COCKPIT_LABEL_ID, STARRED } from '../gmail-payloads.js';
import { GmailWorld, signedInHost } from './gmail-world.js';

/**
 * L1, against a fake host and Gmail faked at the network: a Task done, dismissed
 * or reopened in Cockpit reaches the conversation's label or star before
 * anything is read ("Build Gmail as a connector package on the SDK,
 * unregistered", issue 943).
 */

function answered(answer: MirroredOpenStates): { confirmed: string[]; gaveUp: string[] } {
  if (Array.isArray(answer)) return { confirmed: answer, gaveUp: [] };
  return { confirmed: answer.confirmed ?? [], gaveUp: answer.gaveUp ?? [] };
}

describe('Connector management', () => {
  describe('a Task closed or reopened in Cockpit takes the label or star off its conversation, or puts it back, until Gmail has it', () => {
    it.each([
      { situation: 'closed, by label', choice: 'label', mark: 'label', open: false, markId: COCKPIT_LABEL_ID, holds: false },
      { situation: 'reopened, by label', choice: 'label', mark: 'label', open: true, markId: COCKPIT_LABEL_ID, holds: true },
      { situation: 'closed, by star', choice: 'star', mark: 'star', open: false, markId: STARRED, holds: false },
      { situation: 'reopened, by star', choice: 'star', mark: 'star', open: true, markId: STARRED, holds: true },
    ] as const)('$situation: the conversation ends up as wanted, and the change is confirmed', async (one) => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One', 'x', [one.mark]);
      if (one.open) world.unmark('t-1', one.mark);

      const answer = await world.connector().mirrorOpenState!(signedInHost({ choice: one.choice }), [
        { sourceId: 't-1', open: one.open },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['t-1'], gaveUp: [] });
      expect(world.labelsOf('t-1').includes(one.markId)).toBe(one.holds);
    });

    it('touches only the mark followed, and no other label of the conversation', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One', 'x', ['label', 'star']);

      await world.connector().mirrorOpenState!(signedInHost(), [{ sourceId: 't-1', open: false }]);

      expect(world.labelsOf('t-1')).toEqual(expect.arrayContaining(['INBOX', STARRED]));
      expect(world.labelsOf('t-1')).not.toContain(COCKPIT_LABEL_ID);
    });

    it('confirms a conversation that is gone, which has nothing left to mark', async () => {
      const world = new GmailWorld();

      const answer = await world.connector().mirrorOpenState!(signedInHost(), [{ sourceId: 'vanished', open: false }]);

      expect(answered(answer).confirmed).toEqual(['vanished']);
    });

    it('gives up on a change Gmail refuses for good, and carries on with the rest', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');
      world.arrives('t-2', 'Two');
      world.modifyStatus = (id) => (id === 't-1' ? 400 : 200);
      const host = signedInHost();

      const answer = await world.connector().mirrorOpenState!(host, [
        { sourceId: 't-1', open: false },
        { sourceId: 't-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: ['t-2'], gaveUp: ['t-1'] });
      expect(host.logged.some((one) => one.level === 'warn')).toBe(true);
    });

    it.each([
      { situation: 'a rate limit', status: 429 },
      { situation: 'Gmail failing', status: 503 },
    ])('hands a change back next run, neither confirmed nor given up, on $situation', async ({ status }) => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');
      world.arrives('t-2', 'Two');
      world.modifyStatus = () => status;

      const answer = await world.connector().mirrorOpenState!(signedInHost(), [
        { sourceId: 't-1', open: false },
        { sourceId: 't-2', open: false },
      ]);

      expect(answered(answer)).toEqual({ confirmed: [], gaveUp: [] });
    });

    it('is pushed before a run reads anything, and spends the same call budget as the read', async () => {
      const world = new GmailWorld();
      for (let at = 0; at < 80; at += 1) world.arrives(`t-${at}`, `Subject ${at}`);
      const connector = world.connector();
      const host = signedInHost();

      await connector.mirrorOpenState!(host, [{ sourceId: 't-0', open: false }]);
      const answer = await connector.sync(host);

      expect(answer).toEqual({ moreToDo: true });
      const modify = world.requests.findIndex((one) => one.includes('/modify'));
      const firstRead = world.requests.findIndex((one) => /threads\/[^/]+\?format/.test(one));
      expect(modify).toBeGreaterThanOrEqual(0);
      expect(modify).toBeLessThan(firstRead);
      expect(world.gmailCalls()).toBeLessThanOrEqual(CALLS_PER_RUN);
    });
  });
});
