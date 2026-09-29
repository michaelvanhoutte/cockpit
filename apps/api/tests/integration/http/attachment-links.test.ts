import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import {
  ATTACHMENT_LINK_LIFETIME_MS,
  ATTACHMENT_LINK_PREFIX,
  attachmentLinkKey,
  sealAttachmentLink,
} from '../../../src/auth/attachment-link.js';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  accountOf,
  asUser,
  seedRegister,
  startFromEmpty,
  taskTypeIn,
} from '../seed.js';

/**
 * Integration level, through the real Worker and signed out: whether a link
 * opens its file is the route, the account's own store and R2 together
 * ("Send an item's attachments along when an agent starts", issue 573).
 *
 * Links are made here with the Worker's own key rather than by starting an
 * agent, since an expired or another account's link is not something a start
 * can be made to hand out; that a start's message carries a working link is
 * agent-runs.test.ts's.
 */

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};
const AT = '2026-09-29T10:00:00.000Z';
const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

async function postChange(name: string, payload: Record<string, unknown>, userId = USER_ID) {
  const res = await asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...payload }),
    },
    userId,
  );
  expect(res.status).toBe(200);
}

/** An Item with one PNG on it, in `userId`'s account. */
async function aFileOnAnItem(userId = USER_ID): Promise<{ itemId: string; attachmentId: string }> {
  const itemId = nextId();
  const attachmentId = nextId();
  await postChange(
    'capture_item',
    { workspaceId: WORKSPACE_ID, itemId, message: 'A broken layout', typeId: taskTypeIn(accountOf(userId)) },
    userId,
  );
  const res = await asUser(
    `http://cockpit.test/v1/items/${itemId}/attachments`,
    {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-attachment-id': attachmentId,
        'x-command-id': nextId(),
        'x-issued-at': AT,
        'x-workspace-id': WORKSPACE_ID,
        'x-filename': 'layout.png',
      },
      body: BYTES,
    },
    userId,
  );
  expect(res.status).toBe(201);
  return { itemId, attachmentId };
}

async function linkTo(attachmentId: string, madeAt = new Date()): Promise<string> {
  const key = await attachmentLinkKey(env.CONNECTOR_CREDENTIAL_KEY);
  return `${ATTACHMENT_LINK_PREFIX}${await sealAttachmentLink(key!, { accountName: ACCOUNT_NAME, attachmentId }, madeAt)}`;
}

/** Flips one character of the token, keeping it the same alphabet. */
function altered(link: string): string {
  const at = link.length - 5;
  return link.slice(0, at) + (link[at] === 'A' ? 'B' : 'A') + link.slice(at + 1);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Agents', () => {
  describe('a link sent with an agent opens exactly one file, for an hour, without signing in', () => {
    it.each([
      {
        situation: 'a fresh link for this file',
        link: async () => linkTo((await aFileOnAnItem()).attachmentId),
        opens: true,
      },
      {
        situation: 'a link past its hour',
        link: async () =>
          linkTo((await aFileOnAnItem()).attachmentId, new Date(Date.now() - ATTACHMENT_LINK_LIFETIME_MS - 1000)),
        opens: false,
      },
      {
        situation: 'a link altered by one character',
        link: async () => altered(await linkTo((await aFileOnAnItem()).attachmentId)),
        opens: false,
      },
      {
        situation: 'a link to a file removed from its item since',
        link: async () => {
          const { itemId, attachmentId } = await aFileOnAnItem();
          const link = await linkTo(attachmentId);
          await postChange('remove_attachment', { workspaceId: WORKSPACE_ID, itemId, attachmentId });
          return link;
        },
        opens: false,
      },
      {
        situation: 'a link naming another account’s file',
        link: async () => linkTo((await aFileOnAnItem(OTHER_USER_ID)).attachmentId),
        opens: false,
      },
    ])('$situation', async ({ link, opens }) => {
      const res = await SELF.fetch(`http://cockpit.test${await link()}`);

      if (opens) {
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
      } else {
        expect(res.status).toBe(404);
        await res.body?.cancel();
      }
    });
  });
});
