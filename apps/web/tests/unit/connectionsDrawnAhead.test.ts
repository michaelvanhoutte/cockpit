import { describe, expect, it } from 'vitest';
import type { SourceAccount, SourceAccountList } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { connectionsDrawnOver } from '../../src/connectionsDrawnAhead';

/**
 * F1: what each connection change draws over the list the server sent. That the
 * controls send them, and that the window draws the result, is
 * tests/unit/components/ConnectionsAtOnce.test.tsx; when they stop being drawn is
 * tests/unit/changeQueue.test.ts.
 */

const AT = '2026-10-21T09:00:00.000Z';

const MAIL: SourceAccount = {
  id: 'account-mail',
  connectorId: 'outlook',
  displayName: 'Ada’s mail',
  connectedAt: '2026-09-18T09:00:00.000Z',
  lastTestedAt: null,
  failingBecause: null,
  follows: 'flag',
  followsLabel: 'Flagged mail',
  followsListed: 'flagged',
  filesByName: false,
};
const TEAMS: SourceAccount = { ...MAIL, id: 'account-teams', connectorId: 'teams', displayName: 'Ada Lovelace' };
const held: SourceAccountList = { sourceAccounts: [MAIL, TEAMS] };

const WORDS: Record<string, string> = { 'outlook/all': 'Every message', 'outlook/flag': 'Flagged mail' };
const labelOf = (connectorId: string, choice: string) => WORDS[`${connectorId}/${choice}`];
const over = connectionsDrawnOver('ws-work', labelOf);

const disconnected = (sourceAccountId: string, workspaceId = 'ws-work'): CommandArgs => ({
  name: 'disconnect_source_account',
  payload: { commandId: 'c-gone', issuedAt: AT, workspaceId, sourceAccountId },
});
const chose = (choice: string, workspaceId = 'ws-work'): CommandArgs => ({
  name: 'set_connection_choice',
  payload: { commandId: `c-${choice}`, issuedAt: AT, workspaceId, sourceAccountId: 'account-mail', choice },
});
const filing = (filesByName: boolean): CommandArgs => ({
  name: 'set_connection_files_by_name',
  payload: { commandId: `c-files-${String(filesByName)}`, issuedAt: AT, workspaceId: 'ws-work', sourceAccountId: 'account-mail', filesByName },
});

const rows = (list: SourceAccountList) => list.sourceAccounts.map((row) => row.id);
const mail = (list: SourceAccountList) => list.sourceAccounts.find((row) => row.id === 'account-mail')!;

describe('Connector management', () => {
  describe('a connection change is drawn as the server will have it', () => {
    it('takes a disconnected connection out of the list and leaves the others', () => {
      expect(rows(over(held, [disconnected('account-teams')]))).toEqual(['account-mail']);
    });

    it('names the new choice in its connector’s words, and drops what the old choice counted', () => {
      const drawn = mail(over(held, [chose('all')]));

      expect(drawn).toMatchObject({ follows: 'all', followsLabel: 'Every message' });
      expect(drawn.followsListed).toBeUndefined();
    });

    it('shows the raw choice when its connector has no words for it', () => {
      const drawn = mail(over(held, [chose('unlisted')]));

      expect(drawn.follows).toBe('unlisted');
      expect(drawn.followsLabel).toBeUndefined();
    });

    it('turns files by name on, and off again', () => {
      expect(mail(over(held, [filing(true)])).filesByName).toBe(true);
      expect(mail(over(held, [filing(true), filing(false)])).filesByName).toBe(false);
    });

    it('draws a choice and files by name made together on the one connection', () => {
      expect(mail(over(held, [chose('all'), filing(true)]))).toMatchObject({ follows: 'all', filesByName: true });
    });

    it('draws a connection that is changed and then disconnected as gone', () => {
      expect(rows(over(held, [chose('all'), disconnected('account-mail')]))).toEqual(['account-teams']);
    });

    it.each([
      { situation: 'a disconnect', change: disconnected('account-mail', 'ws-other') },
      { situation: 'a choice', change: chose('all', 'ws-other') },
    ])('leaves the list alone for $situation of another Workspace’s connection', ({ change }) => {
      expect(over(held, [change])).toEqual(held);
    });

    it('never writes to the list it was given', () => {
      over(held, [disconnected('account-mail'), chose('all'), filing(true)]);

      expect(held).toEqual({ sourceAccounts: [MAIL, TEAMS] });
    });
  });
});
