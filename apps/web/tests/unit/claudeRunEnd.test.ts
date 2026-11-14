import { describe, expect, it } from 'vitest';
import type { AgentRun, Item } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { barEntryFor, claudeEntriesFor, endSeveral, reopenSeveral, targetsOf } from '../../src/claudeRunEnd';
import type { Sending } from '../../src/bulkEdit';

/**
 * F1: which entries a row's Claude group holds, which picked rows the selection
 * bar ends a run on and what its Undo sends (issue 1770). That the row and the bar
 * draw them is ItemRow.test.tsx's and EditingSeveral.test.tsx's.
 */

const anItem = (id: string) => ({ id, title: `Item ${id}` }) as unknown as Item;
const aRun = (id: string, itemId: string) => ({ id, itemId }) as unknown as AgentRun;
const AT = '2026-10-20T09:00:00.000Z';

type Sent = { itemId: string; runId?: string; reopen?: boolean };

describe('Agents', () => {
  describe('the row’s Claude group offers End Claude run only while the Item has an open run, under the session', () => {
    it.each([
      { situation: 'a run with a session link', options: { canSend: false, sessionHref: 'https://claude.ai/code/session_01', hasRun: true }, entries: ['session', 'end'] },
      { situation: 'a Sent run with no link yet', options: { canSend: false, sessionHref: null, hasRun: true }, entries: ['end'] },
      { situation: 'no open run', options: { canSend: true, sessionHref: null, hasRun: false }, entries: ['send'] },
      { situation: 'no open run and nothing to send', options: { canSend: false, sessionHref: null, hasRun: false }, entries: [] },
    ])('holds $entries for $situation', ({ options, entries }) => {
      expect(claudeEntriesFor(options)).toEqual(entries);
    });
  });

  describe('the selection bar ends the run of every picked Item that has one, and leaves the rest alone', () => {
    const sendingInto = (sent: CommandArgs[]): Sending => ({
      send: async (command) => {
        sent.push(command);
        return { applied: true };
      },
      envelope: (itemId) => () => ({ commandId: `c-${sent.length}`, issuedAt: AT, workspaceId: 'ws', itemId }),
    });

    it('sends one end per picked Item with a run, and its Undo reopens exactly those', async () => {
      const picked = [anItem('a'), anItem('b'), anItem('c')];
      const targets = targetsOf(picked, [aRun('run-a', 'a'), aRun('run-c', 'c')]);
      const sent: CommandArgs[] = [];

      const { ended } = await endSeveral(sendingInto(sent), { targets });
      await reopenSeveral(sendingInto(sent), ended);

      expect(sent.map((command) => [command.name, command.payload as Sent])).toEqual([
        ['end_claude_run', expect.objectContaining({ itemId: 'a', runId: 'run-a' })],
        ['end_claude_run', expect.objectContaining({ itemId: 'c', runId: 'run-c' })],
        ['end_claude_run', expect.objectContaining({ itemId: 'a', runId: 'run-a', reopen: true })],
        ['end_claude_run', expect.objectContaining({ itemId: 'c', runId: 'run-c', reopen: true })],
      ]);
    });

    it.each([
      { situation: 'two picked, one with a run', runs: [aRun('run-a', 'a')], available: true, why: null },
      { situation: 'two picked, none with a run', runs: [], available: false, why: 'None of them has a Claude run' },
    ])('with $situation the action is available: $available', ({ runs, available, why }) => {
      expect(barEntryFor(targetsOf([anItem('a'), anItem('b')], runs))).toEqual({ available, why });
    });

    it('says the runs could not come back where the server declines the Undo', async () => {
      const targets = targetsOf([anItem('a')], [aRun('run-a', 'a')]);
      const declining: Sending = { send: async () => ({ applied: false }), envelope: (itemId) => () => ({ commandId: 'c', issuedAt: AT, workspaceId: 'ws', itemId }) };

      await expect(reopenSeveral(declining, targets)).rejects.toThrow('That item changed somewhere else.');
    });

    it('records a refused Item and goes on with the rest', async () => {
      const targets = targetsOf([anItem('a'), anItem('b')], [aRun('run-a', 'a'), aRun('run-b', 'b')]);
      const sending: Sending = {
        send: async (command) => {
          if ((command.payload as Sent).itemId === 'a') throw new Error('No such run.');
          return { applied: true };
        },
        envelope: (itemId) => () => ({ commandId: 'c', issuedAt: AT, workspaceId: 'ws', itemId }),
      };

      const { ended, refused } = await endSeveral(sending, { targets });

      expect([ended.map((t) => t.item.id), refused.map((r) => [r.item.id, r.why])]).toEqual([['b'], [['a', 'No such run.']]]);
    });
  });
});
