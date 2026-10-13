import { describe, expect, it } from 'vitest';
import { LIST_FIELDS, READ_FIELDS, deletedItemsIn, markFilter, messageFrom, messagePage } from '../../src/messages.js';
import { deletedItemsAnswer, message, messagesPage } from '../graph-payloads.js';

/**
 * The contract tier: the calls the Outlook connector reads, asked of Microsoft
 * Graph itself against a dedicated Microsoft 365 test mailbox
 * (docs/testing-strategy.md, "Third parties"; "Build Outlook as a connector
 * package on the SDK, unregistered", issue 1046). **Never per change**
 * (.github/workflows/contract.yml): it reaches the network, and what it holds is
 * Microsoft's decision rather than ours.
 *
 * What only this tier can prove: that Graph still answers in the shapes
 * tests/graph-payloads.ts records - which every tier below is faked with - and
 * that the connector's own readers still make sense of a live answer. A
 * failure means those payloads describe a Graph that no longer exists, and
 * updating them is priority work, never something to re-run until it passes.
 *
 * **It needs a mailbox of its own**: a work or school account holding a
 * message flagged for follow-up and a message categorised Cockpit (not
 * necessarily different ones), and a folder called Archive; signed in to once
 * through an Entra application allowed `Mail.ReadWrite`, and that sign-in's
 * refresh token kept as a secret. Without the three secrets below it skips,
 * saying so, rather than reaching for anybody's real mail.
 */

const clientId = process.env.OUTLOOK_CONTRACT_CLIENT_ID ?? '';
const clientSecret = process.env.OUTLOOK_CONTRACT_CLIENT_SECRET ?? '';
const refreshToken = process.env.OUTLOOK_CONTRACT_REFRESH_TOKEN ?? '';
const provisioned = Boolean(clientId && clientSecret && refreshToken);

const PREFER = { prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' };

let accessToken: Promise<string> | null = null;

/** One access token for the run, refreshed as the connector refreshes it. */
function signedIn(): Promise<string> {
  accessToken ??= (async () => {
    const answer = await fetch('https://login.microsoftonline.com/organizations/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(answer.ok, `Microsoft answered ${answer.status} to a refresh`).toBe(true);
    const { access_token: token } = (await answer.json()) as { access_token?: unknown };
    expect(typeof token).toBe('string');
    return token as string;
  })();
  return accessToken;
}

async function graph(path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
  const answer = await fetch(`https://graph.microsoft.com/v1.0/me/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${await signedIn()}`,
      ...PREFER,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(answer.ok, `Graph answered ${answer.status} to ${path.split('?')[0]}`).toBe(true);
  return (await answer.json()) as Record<string, unknown>;
}

/**
 * The fields a recorded payload carries, each with the type of its value -
 * arrays read through their first element - so a live answer can be held to
 * carry at least the same.
 */
function shapeOf(value: unknown, at = ''): Map<string, string> {
  const shape = new Map<string, string>();
  if (Array.isArray(value)) {
    shape.set(at, 'array');
    if (value.length > 0) for (const [path, type] of shapeOf(value[0], `${at}[]`)) shape.set(path, type);
  } else if (value && typeof value === 'object') {
    shape.set(at, 'object');
    for (const [key, inner] of Object.entries(value)) {
      for (const [path, type] of shapeOf(inner, at ? `${at}.${key}` : key)) shape.set(path, type);
    }
  } else {
    shape.set(at, typeof value);
  }
  return shape;
}

/** What the recorded payload has that the live answer lacks, or carries as another type. */
function missingFrom(live: unknown, recorded: unknown, reads: readonly string[]): string[] {
  const has = shapeOf(live);
  const wanted = shapeOf(recorded);
  return reads.filter((path) => has.get(path) !== wanted.get(path)).map((path) => `${path}: ${wanted.get(path)} wanted, ${has.get(path) ?? 'nothing'} found`);
}

const list = (mark: 'flag' | 'category') =>
  graph(`messages?$filter=${encodeURIComponent(markFilter(mark))}&$select=${LIST_FIELDS}&$top=50`);

describe.skipIf(!provisioned)('Capture', () => {
  describe('Microsoft Graph still answers the calls the connector reads in the shapes it reads', () => {
    it('names the Deleted Items folder by its well-known name', async () => {
      const live = await graph('mailFolders/deleteditems?$select=id');

      expect(missingFrom(live, deletedItemsAnswer(), ['id'])).toEqual([]);
      expect(deletedItemsIn(live)).toBeTruthy();
    });

    it('lists the flagged messages, and the ones categorised Cockpit, with their folder, flag and categories', async () => {
      const deletedItems = deletedItemsIn(await graph('mailFolders/deleteditems?$select=id'))!;
      for (const mark of ['flag', 'category'] as const) {
        const live = await list(mark);

        expect(missingFrom(live, messagesPage([message({ id: 'a-message' })]), ['value', 'value[].id', 'value[].parentFolderId', 'value[].flag', 'value[].flag.flagStatus', 'value[].categories'])).toEqual([]);
        expect(messagePage(live, mark, deletedItems).messageIds.length, `the test mailbox holds no message for ${mark}`).toBeGreaterThan(0);
      }
    });

    it('leaves a marked message in Deleted Items out of the listing the connector reads', async () => {
      const deletedItems = deletedItemsIn(await graph('mailFolders/deleteditems?$select=id'))!;
      const live = await list('flag');
      const inDeletedItems = ((live.value as { id: string; parentFolderId: string }[]) ?? []).filter((one) => one.parentFolderId === deletedItems).map((one) => one.id);

      const { messageIds } = messagePage(live, 'flag', deletedItems);

      for (const id of inDeletedItems) expect(messageIds).not.toContain(id);
    });

    it('reads one message whole, with a subject, a sender, a text body, a link and when it arrived', async () => {
      const deletedItems = deletedItemsIn(await graph('mailFolders/deleteditems?$select=id'))!;
      const [id] = messagePage(await list('flag'), 'flag', deletedItems).messageIds;
      expect(id).toBeTruthy();

      const live = await graph(`messages/${encodeURIComponent(id!)}?$select=${READ_FIELDS}`);

      expect(
        missingFrom(live, message({ id: 'a-message' }), [
          'id',
          'parentFolderId',
          'subject',
          'receivedDateTime',
          'webLink',
          'categories',
          'flag.flagStatus',
          'body.contentType',
          'body.content',
          'from.emailAddress.address',
        ]),
      ).toEqual([]);
      const read = messageFrom(live, 'flag', deletedItems);
      expect(read?.title).toBeTruthy();
      expect(read?.link).toMatch(/^https:\/\//);
      expect(read?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    // Moved to Archive and back in the same case, so the mailbox ends as it started.
    it('keeps a message’s immutable id when it moves to Archive', async () => {
      const deletedItems = deletedItemsIn(await graph('mailFolders/deleteditems?$select=id'))!;
      const [id] = messagePage(await list('flag'), 'flag', deletedItems).messageIds;
      expect(id).toBeTruthy();
      const before = await graph(`messages/${encodeURIComponent(id!)}?$select=id,parentFolderId`);

      const moved = await graph(`messages/${encodeURIComponent(id!)}/move`, { method: 'POST', body: { destinationId: 'archive' } });
      try {
        expect(moved.id, 'Graph changed the id of a message that moved').toBe(id);
        expect(moved.parentFolderId).not.toBe(before.parentFolderId);
      } finally {
        await graph(`messages/${encodeURIComponent(String(moved.id))}/move`, { method: 'POST', body: { destinationId: before.parentFolderId } });
      }
    });
  });
});
