import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Item } from '@cockpit/shared';
import {
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import {
  CONVERSATION,
  MESSAGE_ID,
  TEAMS_PERSON,
  TEAMS_TENANT,
  botFrameworkIsReachable,
  channelToken,
  saveToCockpitCall,
} from '../bot-framework.js';

/**
 * Integration level, through the real Worker, because what is being asked is
 * the wiring: one address every connected account shares, a register that says
 * whose a call is, a store that confirms it, and an Item that comes out the
 * other end. Which claims a call has to carry, and what is read out of one, is
 * the connector package's own L1 suite and is not re-proved here.
 *
 * **This is the coverage ceiling for saving a message** (issue 486): Cockpit's
 * browser suite cannot drive Teams' own menus, so what stands in for a walk is
 * a recorded call at the real address and the Item read back through the
 * application's own read, which is what a person would be looking at.
 *
 * Both third parties are faked at the network boundary and nothing else is
 * (../issuer.ts, ../bot-framework.ts).
 */

const ADA = { email: 'ada@example.com', name: 'Ada Lovelace' };

/** Connecting a Teams account to a Workspace, the whole walk a browser makes. */
async function connectTeams(workspaceId = WORKSPACE_ID, person = TEAMS_PERSON): Promise<void> {
  await issuerIsReachable();
  const session = await signInAs(USER_ID);
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/teams/connect`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  expect(started.status).toBe(302);
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({
    ...ADA,
    nonce: asked.searchParams.get('nonce')!,
    tenant: TEAMS_TENANT,
    object: person,
  });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/teams/callback?${new URLSearchParams({
      code: 'a-code',
      state: asked.searchParams.get('state')!,
    })}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${workspaceId}?connections=connected`);
  // From here on the only third party is the channel, and the sign-in issuer
  // must be out of reach again: whichever `fetch` is stubbed last is the one
  // the Worker gets.
  await botFrameworkIsReachable();
}

/** Somebody picking "Save to Cockpit" on a message, as Teams delivers it. */
async function saveFromTeams(
  call: { token?: string; activity?: unknown } = {},
): Promise<Response> {
  return SELF.fetch('http://cockpit.test/ingress/teams/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${call.token ?? (await channelToken())}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(call.activity ?? saveToCockpitCall()),
  });
}

/** What the Inbox would show: the Workspace's items, as the application reads them. */
async function itemsIn(workspaceId = WORKSPACE_ID): Promise<Item[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Item[] }).items;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
});

afterEach(() => {
  issuerIsForgotten();
});

describe('Capture', () => {
  describe('a message saved from Teams becomes an item in the workspace that connected the account', () => {
    it('files the message, who sent it, when, and the way back to it', async () => {
      await connectTeams();

      const answer = await saveFromTeams();

      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({
        composeExtension: { type: 'message', text: 'Saved to Cockpit.' },
      });
      const items = await itemsIn();
      expect(items).toHaveLength(1);
      expect({
        source: items[0]!.source,
        sender: items[0]!.sender,
        sourceLink: items[0]!.sourceLink,
        sourceTimestamp: items[0]!.sourceTimestamp,
        capturedMessage: items[0]!.capturedMessage,
        title: items[0]!.title,
      }).toEqual({
        source: 'teams',
        sender: 'Grace Hopper',
        sourceLink: `https://teams.microsoft.com/l/message/${CONVERSATION}/${MESSAGE_ID}?tenantId=${TEAMS_TENANT}`,
        sourceTimestamp: '2026-09-15T09:20:00.000Z',
        capturedMessage: 'Can you review the Q3 plan before Friday?',
        title: 'Can you review the Q3 plan before Friday?',
      });
    });

    it('leaves it out of the workspaces that connected nothing', async () => {
      await connectTeams();

      await saveFromTeams();

      expect(await itemsIn('ws-atlas')).toEqual([]);
    });

    it('lands where that account was connected last, when two workspaces connected it', async () => {
      await connectTeams();
      await connectTeams('ws-atlas');

      await saveFromTeams();

      expect(await itemsIn('ws-atlas')).toHaveLength(1);
      expect(await itemsIn()).toEqual([]);
    });
  });

  describe('the same message saved twice is one item, however often Teams delivers it', () => {
    it('makes one item out of a delivery repeated', async () => {
      await connectTeams();

      const first = await saveFromTeams();
      const again = await saveFromTeams();

      expect([first.status, again.status]).toEqual([200, 200]);
      expect(await itemsIn()).toHaveLength(1);
    });

    it('makes a second item for a second message', async () => {
      await connectTeams();

      await saveFromTeams();
      await saveFromTeams({ activity: saveToCockpitCall({ messageId: '1757930999000', said: 'And this one' }) });

      expect(await itemsIn()).toHaveLength(2);
    });
  });

  describe('a saved message reaches the inbox only when Microsoft signed the call for this Cockpit', () => {
    it.each([
      {
        situation: 'a signature no published key matches',
        call: async () => ({ token: await channelToken({ forged: true }) }),
        status: 401,
      },
      {
        situation: 'a token that ran out',
        call: async () => ({ token: await channelToken({ expiresIn: -60 }) }),
        status: 401,
      },
      {
        situation: 'a genuine token minted for another bot',
        call: async () => ({ token: await channelToken({ audience: 'another-bot-entirely' }) }),
        status: 401,
      },
      {
        situation: 'a call with no token at all',
        call: async () => ({ token: '' }),
        status: 401,
      },
      {
        situation: 'a click on something this app does not offer',
        call: async () => ({ activity: saveToCockpitCall({ commandId: 'deleteEverything' }) }),
        status: 400,
      },
    ])('$situation is refused, and nothing is filed', async ({ call, status }) => {
      await connectTeams();

      const answer = await saveFromTeams(await call());

      expect(answer.status).toBe(status);
      expect(await itemsIn()).toEqual([]);
    });
  });

  describe('a save naming an account nobody connected is answered plainly and files nothing', () => {
    it('tells whoever clicked, and leaves every workspace as it was', async () => {
      await connectTeams();

      const answer = await saveFromTeams({
        activity: saveToCockpitCall({ person: 'somebody-else-entirely' }),
      });

      expect(answer.status).toBe(200);
      expect(JSON.stringify(await answer.json())).toContain('not connected');
      expect(await itemsIn()).toEqual([]);
    });

    it('stops believing the register the moment the connection is disconnected', async () => {
      await connectTeams();
      const connections = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
      const [connected] = ((await connections.json()) as { sourceAccounts: { id: string }[] })
        .sourceAccounts;
      await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '0195c0f6-0000-7000-8000-000000000001',
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          sourceAccountId: connected!.id,
        }),
      });

      const answer = await saveFromTeams();

      expect(answer.status).toBe(200);
      expect(JSON.stringify(await answer.json())).toContain('not connected');
      expect(await itemsIn()).toEqual([]);
    });
  });

  describe('a save that cannot be filed fails the call, so the next delivery still lands once', () => {
    it('refuses while there is no type to capture as, and files one item when there is', async () => {
      await connectTeams();
      // An account can be left with no Types at all, every one of them being
      // deletable - and a saved message has to name one, with nobody at a
      // keyboard to pick it.
      await inTheStore((sql) => sql.exec('DELETE FROM item_types'));

      const failed = await saveFromTeams();

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await itemsIn()).toEqual([]);

      await asUser('http://cockpit.test/v1/commands/create_item_type', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '0195c0f6-0000-7000-8000-000000000002',
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          typeId: '0195c0f6-0000-7000-8000-000000000003',
          name: 'Note',
        }),
      });

      const delivered = await saveFromTeams();
      const again = await saveFromTeams();

      expect([delivered.status, again.status]).toEqual([200, 200]);
      expect(await itemsIn()).toHaveLength(1);
    });
  });

  describe('a Cockpit with no bot behind it offers no address to save to', () => {
    it('answers as it does for a source it has never heard of', async () => {
      await connectTeams();
      const configured = env.MS_BOT_APP_ID;
      delete (env as { MS_BOT_APP_ID?: string }).MS_BOT_APP_ID;
      try {
        const answer = await saveFromTeams();

        expect(answer.status).toBe(404);
        expect(await itemsIn()).toEqual([]);
      } finally {
        (env as { MS_BOT_APP_ID?: string }).MS_BOT_APP_ID = configured;
      }
    });
  });
});
