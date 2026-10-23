import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { DASHBOARD_ID, OTHER_USER_ID, USER_ID, WORKSPACE_ID, asUser, besidesTheGuide, seedRegister, signInAs, startFromEmpty } from '../seed.js';
import {
  CALLBACK,
  ORIGIN,
  READ_PANELS,
  WIDGET_CALLBACK,
  attempt,
  connected,
  decide,
  mcp,
  refresh,
  registerApp,
  tradeCode,
} from './connected-apps.support.js';

/**
 * Integration level, through the whole Worker: an app allowed only to read your
 * Panels ("Read a Panel from an app allowed only to read, and open Capture from
 * its address", issue 1445). Every case enters as the app does - registering,
 * the consent page, the code exchange, then the address it reads - because what
 * a token may reach is routing and token checks, and only the real routes and
 * the real library hold them. What the reads answer is
 * apps/api/tests/integration/http/panel-reads.test.ts, and the rules the answers
 * are made by are packages/shared/tests/unit/domain/panel-read.test.ts.
 */

const PANELS = `${ORIGIN}/mcp/reads/v1/panels`;
const A_DAY = '2026-10-23';

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  vi.useRealTimers();
});

/** One read of Panels, as the widget makes it: the list, or one Panel on the phone's day. */
function read(token: string | null, panelId?: string, cookie?: string): Promise<Response> {
  const address = panelId === undefined ? PANELS : `${PANELS}/${encodeURIComponent(panelId)}?date=${A_DAY}`;
  return SELF.fetch(address, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
  });
}

let seq = 0;
const nextId = () => `018f0000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

/** A Panel of items on the first Dashboard, for a read to be made of. */
async function aPanel(userId: string = USER_ID, name = 'Falcon'): Promise<string> {
  const panelId = nextId();
  const added = await asUser(
    `${ORIGIN}/v1/commands/add_panel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: nextId(),
        issuedAt: '2026-10-01T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        dashboardId: DASHBOARD_ID,
        panelId,
        name,
        kind: 'items',
      }),
    },
    userId,
  );
  expect(added.status).toBe(200);
  return panelId;
}

/** What an Inbox holds of the Items the person captured, as their own browser reads it. */
async function itemsOf(userId: string = USER_ID): Promise<string[]> {
  const answer = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`, {}, userId);
  return besidesTheGuide(((await answer.json()) as { items: { title: string }[] }).items).map((item) => item.title);
}

const capturing = (token: string) =>
  mcp(token, 'tools/call', { name: 'create_item', arguments: { message: 'Stored by an app that may only read' } });

describe('MCP connections', () => {
  describe('an app allowed only to read your Panels can read them and do nothing else, and an app allowed to capture cannot read them', () => {
    const asksToCapture = (token: string) => capturing(token);
    it.each([
      {
        situation: 'allowed to read Panels, asks to list Panels',
        send: async () => read((await connected(USER_ID, 'Widget', { reading: true })).token),
        status: 200,
        stored: 0,
      },
      {
        situation: 'allowed to read Panels, asks to read a Panel',
        send: async () => {
          const panelId = await aPanel();
          return read((await connected(USER_ID, 'Widget', { reading: true })).token, panelId);
        },
        status: 200,
        stored: 0,
      },
      {
        situation: 'allowed to read Panels, asks to capture an Item',
        send: async () => asksToCapture((await connected(USER_ID, 'Widget', { reading: true })).token),
        status: 403,
        stored: 0,
      },
      {
        situation: 'allowed to capture, as Claude is, asks to read a Panel',
        send: async () => {
          const panelId = await aPanel();
          return read((await connected(USER_ID, 'Claude')).token, panelId);
        },
        status: 403,
        stored: 0,
      },
      {
        situation: 'allowed to capture, as Claude is, asks to capture an Item',
        send: async () => asksToCapture((await connected(USER_ID, 'Claude')).token),
        status: 200,
        stored: 1,
      },
      {
        situation: 'allowed to read Panels and, in the same breath, to something else, asks to capture an Item',
        send: async () => {
          const app = await registerApp('Greedy', WIDGET_CALLBACK);
          const asked = await attempt(app, WIDGET_CALLBACK, 'state', `${READ_PANELS} create_items`);
          const allowed = await decide(asked.path, await signInAs(USER_ID), 'allow');
          const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
          const traded = await tradeCode(app, code, asked.verifier, WIDGET_CALLBACK);
          return asksToCapture(((await traded.json()) as { access_token: string }).access_token);
        },
        status: 403,
        stored: 0,
      },
      { situation: 'showing no sign-in, asks to read a Panel', send: async () => read(null, await aPanel()), status: 401, stored: 0 },
      {
        situation: 'showing a sign-in that has run out, asks to read a Panel',
        send: async () => {
          const { token } = await connected(USER_ID, 'Widget', { reading: true });
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.advanceTimersByTime(2 * 60 * 60 * 1000);
          return read(token, await aPanel());
        },
        status: 401,
        stored: 0,
      },
      {
        situation: 'a browser signed in to Cockpit, with no app, asks to read a Panel',
        send: async () => read(null, await aPanel(), await signInAs(USER_ID)),
        status: 401,
        stored: 0,
      },
    ])('$situation', async ({ send, status, stored }) => {
      const before = (await itemsOf()).length;

      const answer = await send();

      expect(answer.status).toBe(status);
      if (status === 401) {
        // Where to go to be let in, which is what an app follows to the consent page.
        expect(answer.headers.get('www-authenticate')).toContain(
          `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        );
      }
      // An app refused for what it may do has written nothing; the one that captured wrote its own.
      expect((await itemsOf()).length - before).toBe(stored);
    });
  });

  describe('signing in from the widget app returns only to the app’s own address, and only with the proof it started with', () => {
    it('accepts an app registering its own address as where sign-in returns', async () => {
      const registered = await SELF.fetch(`${ORIGIN}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Cockpit widget',
          redirect_uris: [WIDGET_CALLBACK],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      });

      expect(registered.status).toBe(201);
      expect(((await registered.json()) as { redirect_uris: string[] }).redirect_uris).toEqual([WIDGET_CALLBACK]);
    });

    it('sends the app back to its own address with a code when sign-in finishes', async () => {
      const app = await registerApp('Cockpit widget', WIDGET_CALLBACK);
      const asked = await attempt(app, WIDGET_CALLBACK, 'the-apps-state', READ_PANELS);

      const allowed = await decide(asked.path, await signInAs(USER_ID), 'allow');

      const back = new URL(allowed.headers.get('location')!);
      expect(`${back.protocol}//${back.host}`).toBe(WIDGET_CALLBACK);
      expect(back.searchParams.get('code')).toBeTruthy();
      expect(back.searchParams.get('state')).toBe('the-apps-state');
    });

    it('refuses the code exchanged without the proof the app began with', async () => {
      const app = await registerApp('Cockpit widget', WIDGET_CALLBACK);
      const asked = await attempt(app, WIDGET_CALLBACK, 'state', READ_PANELS);
      const allowed = await decide(asked.path, await signInAs(USER_ID), 'allow');
      const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;

      const traded = await tradeCode(app, code, `${'p'.repeat(43)}another-proof`, WIDGET_CALLBACK);

      expect(traded.status).toBe(400);
      expect(((await traded.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('refuses an app that registered one private address and asks to return to a different one', async () => {
      const app = await registerApp('Cockpit widget', WIDGET_CALLBACK);
      const asked = await attempt(app, 'cockpit-widget://somewhere-else', 'state', READ_PANELS);

      const shown = await SELF.fetch(`${ORIGIN}${asked.path}`, {
        headers: { cookie: await signInAs(USER_ID) },
        redirect: 'manual',
      });

      expect(shown.status).toBe(400);
      expect(shown.headers.get('location')).toBeNull();
      expect(await shown.text()).not.toContain('name="handle"');
    });
  });

  describe('the consent page says what the app is asking for', () => {
    it.each([
      {
        situation: 'reading your Panels',
        asks: READ_PANELS,
        redirect: WIDGET_CALLBACK,
        says: ['Allow Cockpit widget to read your Panels in your Cockpit?', 'It may read your Panels, and nothing else'],
        doesNotSay: ['create items', 'capture notes'],
      },
      {
        situation: 'capturing, as today',
        asks: undefined,
        redirect: CALLBACK,
        says: ['Allow Cockpit widget to create items in your Cockpit?', 'see the names of your workspaces and types'],
        doesNotSay: ['read your Panels'],
      },
    ])('says $situation in its own words', async ({ asks, redirect, says, doesNotSay }) => {
      const app = await registerApp('Cockpit widget', redirect);
      const { path } = await attempt(app, redirect, 'state', asks);

      const shown = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie: await signInAs(USER_ID) } });
      const page = await shown.text();

      expect(shown.status).toBe(200);
      for (const sentence of says) expect(page).toContain(sentence);
      for (const sentence of doesNotSay) expect(page).not.toContain(sentence);
    });

    it('names an app’s own address whole, since its host says nothing about where access goes', async () => {
      const app = await registerApp('Cockpit widget', WIDGET_CALLBACK);
      const { path } = await attempt(app, WIDGET_CALLBACK, 'state', READ_PANELS);

      const shown = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie: await signInAs(USER_ID) } });

      expect(await shown.text()).toContain(`an app on this device, by opening <strong>${WIDGET_CALLBACK}</strong>`);
    });
  });

  describe('disconnecting an app, or the person losing access, ends its reads at once', () => {
    it('refuses its next read once Disconnect is answered in Settings', async () => {
      const { token } = await connected(USER_ID, 'Widget', { reading: true });
      expect((await read(token)).status).toBe(200);
      const listed = await asUser(`${ORIGIN}/v1/connected-apps`);
      const [app] = ((await listed.json()) as { apps: { id: string }[] }).apps;

      const gone = await asUser(`${ORIGIN}/v1/connected-apps/${app!.id}`, { method: 'DELETE' });

      expect(gone.status).toBe(200);
      expect((await read(token)).status).toBe(401);
    });

    it('refuses its next read once the person’s access has been taken away', async () => {
      const { token } = await connected(OTHER_USER_ID, 'Widget', { reading: true });
      expect((await read(token)).status).toBe(200);

      const disabled = await asUser(`${ORIGIN}/v1/admin/users/${OTHER_USER_ID}/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      });

      expect(disabled.status).toBe(200);
      expect((await read(token)).status).toBe(401);
    });

    it('refuses its next read once the person’s access has been taken away, even where the apps they connected cannot be revoked', async () => {
      const { token } = await connected(OTHER_USER_ID, 'Widget', { reading: true });
      const unreachable = async () => {
        throw new Error('the grants could not be listed');
      };
      env.OAUTH_PROVIDER = { listUserGrants: unreachable, revokeGrant: unreachable };
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const disabled = await asUser(`${ORIGIN}/v1/admin/users/${OTHER_USER_ID}/access`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ disabled: true }),
        });
        expect(disabled.status).toBe(200);

        // Nothing was revoked, so the register is what turns the app away.
        expect((await read(token)).status).toBe(401);
      } finally {
        delete env.OAUTH_PROVIDER;
        logged.mockRestore();
      }
    });

    it('cannot refresh its access once the person’s access has been taken away, though it could before', async () => {
      const { app, refreshToken } = await connected(OTHER_USER_ID, 'Widget', { reading: true });
      const before = await refresh(app, refreshToken);
      expect(before.status).toBe(200);
      const { refresh_token: rotated } = (await before.json()) as { refresh_token: string };

      await asUser(`${ORIGIN}/v1/admin/users/${OTHER_USER_ID}/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      });

      expect((await refresh(app, rotated)).status).toBe(400);
    });
  });

  describe('an app’s reads count toward its 60 asks a minute', () => {
    it('refuses the 61st read inside a minute, saying to wait, and answers one after the minute has passed', async () => {
      const panelId = await aPanel();
      const { token } = await connected(USER_ID, 'Widget', { reading: true });
      for (let n = 1; n <= 30; n += 1) {
        expect((await read(token)).status, `list ${n}`).toBe(200);
        expect((await read(token, panelId)).status, `panel ${n}`).toBe(200);
      }

      const sixtyFirst = await read(token);

      expect(sixtyFirst.status).toBe(429);
      expect(((await sixtyFirst.json()) as { error: string }).error).toContain('Wait a minute');

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.advanceTimersByTime(61_000);
      expect((await read(token)).status).toBe(200);
    });
  });

  describe('Settings › Connected apps lists each app you allowed with what it may do', () => {
    /** The apps `userId` sees listed, as the settings window reads them. */
    async function listed(userId: string = USER_ID) {
      const answer = await asUser(`${ORIGIN}/v1/connected-apps`, {}, userId);
      expect(answer.status).toBe(200);
      return ((await answer.json()) as {
        apps: { name: string; kind: string; lastCapturedAt: string | null; lastReadAt: string | null }[];
      }).apps;
    }

    it('lists both kinds, each saying what it may do', async () => {
      await connected(USER_ID, 'Claude');
      await connected(USER_ID, 'Cockpit widget', { reading: true });

      // Oldest first, and both made inside the second the library counts in.
      expect((await listed()).map(({ name, kind }) => [name, kind]).sort()).toEqual([
        ['Claude', 'captures'],
        ['Cockpit widget', 'reads-panels'],
      ]);
    });

    it('says when an app last read a Panel, which is not when it last captured', async () => {
      const { token } = await connected(USER_ID, 'Cockpit widget', { reading: true });
      const [before] = await listed();
      expect([before?.lastReadAt, before?.lastCapturedAt]).toEqual([null, null]);

      expect((await read(token)).status).toBe(200);

      // Noted after the answer is sent, so it can be a moment behind it.
      await vi.waitFor(async () => {
        const [after] = await listed();
        expect(after?.lastReadAt).not.toBeNull();
        expect(after?.lastCapturedAt).toBeNull();
      });
    });
  });
});
