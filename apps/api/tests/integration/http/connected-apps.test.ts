import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { NEUTRAL_GROUND, type AgentRun, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  besidesTheGuide,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  withoutTheGuide,
} from '../seed.js';
import { issuerIsReachable, issuerWillIdentify } from '../issuer.js';

/**
 * Integration level, through the whole Worker: an app connecting to Cockpit
 * and capturing through it ("Connect Claude to Cockpit, and capture an item
 * from it", issue 599). Every case enters the way an app does - registering,
 * the consent page, the code exchange, `/mcp` - because who is admitted, and as
 * whom, is decided by the routing in front of the application, the library
 * behind it and the register, none of which a lower level holds. What the tool
 * makes of its arguments is proved at L1 (tests/unit/mcp/create-item.test.ts).
 */

const ORIGIN = 'https://cockpit.test';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  vi.useRealTimers();
});

interface App {
  clientId: string;
}

/** Registers an app the way Claude does, by dynamic registration. */
async function registerApp(name = 'Claude', redirect = CALLBACK): Promise<App> {
  const answer = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(answer.status).toBe(201);
  return { clientId: ((await answer.json()) as { client_id: string }).client_id };
}

/** One authorization attempt: the address the app opens, and the secret it keeps back. */
async function attempt(app: App, redirect = CALLBACK, state = 'the-apps-state') {
  const verifier = 'v'.repeat(43) + crypto.randomUUID().replaceAll('-', '');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: redirect,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  });
  return { path: `/oauth/authorize?${query}`, verifier };
}

/** The cookies a response set, as a browser would send them back. */
function cookiesFrom(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!).filter((c) => !c.endsWith('='));
}

/**
 * Opens the consent page as whoever holds `cookie`, and presses one of its two
 * buttons - as whoever holds `pressedWith` by then, which is the same person
 * unless a case says otherwise (`null` for nobody signed in at all).
 */
async function decide(
  path: string,
  cookie: string,
  decision: 'allow' | 'deny',
  pressedWith: string | null = cookie,
): Promise<Response> {
  const shown = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie }, redirect: 'manual' });
  expect(shown.status).toBe(200);
  const form = new URLSearchParams(
    [...(await shown.text()).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)].map(
      ([, name, value]) => [name!, value!],
    ),
  );
  form.set('decision', decision);
  return SELF.fetch(`${ORIGIN}/oauth/authorize`, {
    method: 'POST',
    headers: {
      cookie: [...(pressedWith ? [pressedWith] : []), ...cookiesFrom(shown)].join('; '),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
}

/** An app connected by `userId`: registered, allowed, and its code traded for access. */
async function connected(
  userId: string = USER_ID,
  name = 'Claude',
): Promise<{ app: App; token: string; refreshToken: string }> {
  const app = await registerApp(name);
  const asked = await attempt(app);
  const allowed = await decide(asked.path, await signInAs(userId), 'allow');
  expect(allowed.status).toBe(302);
  const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
  const traded = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: app.clientId,
      code_verifier: asked.verifier,
    }),
  });
  expect(traded.status).toBe(200);
  const tokens = (await traded.json()) as { access_token: string; refresh_token: string };
  return { app, token: tokens.access_token, refreshToken: tokens.refresh_token };
}

/** An app trading its refresh token for new access, as it does once the hour is up. */
function refresh(app: App, refreshToken: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: app.clientId }),
  });
}

/** One MCP request, as an app's Streamable HTTP client sends it. */
function mcp(token: string | null, method: string, params: unknown = {}, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

interface ToolAnswer {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function createItem(token: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: 'create_item', arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, { enum?: string[] }> };
}

async function listedTool(token: string): Promise<ListedTool> {
  const answer = await mcp(token, 'tools/list');
  expect(answer.status).toBe(200);
  const { tools } = ((await answer.json()) as { result: { tools: ListedTool[] } }).result;
  expect(tools.map((tool) => tool.name)).toEqual(['create_item', 'report_run', 'find_items']);
  return tools[0]!;
}

/** Every Item a workspace's Inbox shows, as the app reads it, but those the account arrived with. */
async function inboxOf(workspaceId: string, userId: string = USER_ID): Promise<Item[]> {
  const answer = await asUser(`${ORIGIN}/v1/workspaces/${workspaceId}/snapshot`, {}, userId);
  return besidesTheGuide(((await answer.json()) as { items: Item[] }).items);
}

/** Signs somebody in with Google by address, the way a browser does, and answers their cookie. */
async function googleSignIn(email: string): Promise<string> {
  await issuerIsReachable();
  const started = await SELF.fetch(`${ORIGIN}/v1/sign-in/google`, { redirect: 'manual' });
  const asked = new URL(started.headers.get('location')!);
  issuerWillIdentify({ email, nonce: asked.searchParams.get('nonce')! }, 'new-code');
  const back = await SELF.fetch(
    `${ORIGIN}/v1/sign-in/google/callback?code=new-code&state=${asked.searchParams.get('state')}`,
    { headers: { cookie: cookiesFrom(started).join('; ') }, redirect: 'manual' },
  );
  return cookiesFrom(back).find((c) => c.startsWith('cockpit_session='))!;
}

/** The grants this Cockpit holds for somebody, read where the library keeps them. */
async function grantsOf(userId: string): Promise<{ clientId: string }[]> {
  const { keys } = await env.OAUTH_KV.list({ prefix: `grant:${userId}:` });
  return Promise.all(keys.map(async (key) => (await env.OAUTH_KV.get(key.name, 'json')) as { clientId: string }));
}

describe('MCP connections', () => {
  describe('only an app somebody allowed reaches Cockpit, and a signed-in browser is not enough', () => {
    const situations = [
      { situation: 'an app showing nothing', send: async () => mcp(null, 'tools/list'), answered: false },
      {
        situation: 'an app showing access Cockpit never gave',
        send: async () => mcp(`${USER_ID}:made-up-grant:made-up-secret`, 'tools/list'),
        answered: false,
      },
      {
        situation: 'an app whose access has run out',
        send: async () => {
          const { token } = await connected();
          vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 60 * 60 * 1000 });
          return mcp(token, 'tools/list');
        },
        answered: false,
      },
      {
        situation: 'an app showing the access somebody gave it',
        send: async () => mcp((await connected()).token, 'tools/list'),
        answered: true,
      },
      {
        situation: 'a signed-in browser showing nothing else',
        send: async () => mcp(null, 'tools/list', {}, await signInAs(USER_ID)),
        answered: false,
      },
    ];

    it.each(situations)('$situation', async ({ send, answered }) => {
      const answer = await send();
      expect(answer.status).toBe(answered ? 200 : 401);
      if (!answered) {
        // Where to go to be let in, which is what an app follows to the consent page.
        expect(answer.headers.get('www-authenticate')).toContain(
          `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        );
      }
    });
  });

  describe('an app only ever sends a request and gets an answer', () => {
    it.each(['GET', 'DELETE'])('refuses %s, rather than opening a stream that never ends', async (method) => {
      const { token } = await connected();
      const answer = await SELF.fetch(`${ORIGIN}/mcp`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      });
      expect([answer.status, answer.headers.get('allow')]).toEqual([405, 'POST']);
    });
  });

  describe('an app is never told what broke inside Cockpit, and the break is logged', () => {
    it('answers with a plain apology when the register cannot be read', async () => {
      const { token } = await connected();
      const realRegister = env.DB;
      env.DB = new Proxy({} as typeof env.DB, {
        get: () => {
          throw new Error('register unreachable: disk on fire');
        },
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const answer = await mcp(token, 'tools/list');
        const said = await answer.text();
        expect(answer.status).toBe(500);
        expect(said).toContain('Something went wrong in Cockpit');
        expect(said).not.toContain('disk on fire');
        expect(logged.mock.calls.some(([line]) => String(line).includes('disk on fire'))).toBe(true);
      } finally {
        env.DB = realRegister;
        logged.mockRestore();
      }
    });

    it('answers listing and capturing with a plain apology when the account cannot be read', async () => {
      const { token } = await connected();
      const realStores = env.ACCOUNT;
      const broken = async () => {
        throw new Error('tenant-default could not be brought up to date: disk on fire');
      };
      env.ACCOUNT = {
        idFromName: (name: string) => realStores.idFromName(name),
        get: () => ({ workspaces: broken, appCaptureArrived: broken }),
      } as unknown as typeof env.ACCOUNT;
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const listed = await mcp(token, 'tools/list');
        const listing = JSON.stringify(await listed.json());
        const said = await createItem(token, { message: 'Anything' });

        expect(listing).toContain('Something went wrong in Cockpit');
        expect(said).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Something went wrong in Cockpit') }] });
        expect(`${listing} ${JSON.stringify(said)}`).not.toContain('disk on fire');
        expect(logged.mock.calls.filter(([line]) => String(line).includes('disk on fire'))).toHaveLength(2);
      } finally {
        env.ACCOUNT = realStores;
        logged.mockRestore();
      }
    });
  });

  describe('access is given only on the consent page, by somebody signed in with Google', () => {
    it('sends the app back with a code when somebody signed in presses Allow, naming the app', async () => {
      const app = await registerApp('Claude');
      const { path } = await attempt(app);
      const shown = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie: await signInAs(USER_ID) } });
      const page = await shown.text();
      expect(page).toContain('Allow Claude to create items in your Cockpit?');
      // What it will be able to see, said plainly: the names it is told.
      expect(page).toContain('see the names of your workspaces and types');
      // And, since the app can find items (issue 1240), that it reads them - in every workspace.
      expect(page).toContain('read your items in every workspace');
      expect(page).not.toContain('cannot see your items');
      expect(page).not.toContain('cannot read');

      const allowed = await decide(path, await signInAs(USER_ID), 'allow');
      const back = new URL(allowed.headers.get('location')!);
      expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
      expect(back.searchParams.get('code')).toBeTruthy();
      expect(back.searchParams.get('state')).toBe('the-apps-state');
      expect(await grantsOf(USER_ID)).toEqual([expect.objectContaining({ clientId: app.clientId })]);
    });

    it('tells the app access was refused when somebody presses Deny, and grants nothing', async () => {
      const app = await registerApp();
      const { path } = await attempt(app);
      const denied = await decide(path, await signInAs(USER_ID), 'deny');
      expect(denied.status).toBe(302);
      const back = new URL(denied.headers.get('location')!);
      expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
      expect(back.searchParams.get('error')).toBe('access_denied');
      expect(back.searchParams.get('code')).toBeNull();
      expect(await grantsOf(USER_ID)).toEqual([]);
    });

    it('tells the app access was refused when Deny is pressed after the sign-in has ended', async () => {
      const app = await registerApp();
      const { path } = await attempt(app);
      const denied = await decide(path, await signInAs(USER_ID), 'deny', null);
      expect(denied.status).toBe(302);
      const back = new URL(denied.headers.get('location')!);
      expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
      expect(back.searchParams.get('error')).toBe('access_denied');
    });

    it('grants nothing when somebody else has signed in on the browser by the time Allow is pressed', async () => {
      const app = await registerApp();
      const { path } = await attempt(app);
      const allowed = await decide(path, await signInAs(USER_ID), 'allow', await signInAs(OTHER_USER_ID));
      expect(allowed.status).toBe(409);
      expect(allowed.headers.get('location')).toBeNull();
      expect([...(await grantsOf(USER_ID)), ...(await grantsOf(OTHER_USER_ID))]).toEqual([]);
    });

    it.each([
      { situation: 'an app asking plainly', state: 'the-apps-state' },
      { situation: 'an app whose request carries a 1,500-character state', state: 's'.repeat(1_500) },
    ])('walks somebody not signed in through Google sign-in and back to the consent page, for $situation', async ({ state }) => {
      const { path } = await attempt(await registerApp(), CALLBACK, state);
      const unsigned = await SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
      expect(unsigned.status).toBe(302);
      const toSignIn = new URL(unsigned.headers.get('location')!, ORIGIN);
      expect(toSignIn.pathname).toBe('/v1/sign-in/google');

      await issuerIsReachable();
      const started = await SELF.fetch(toSignIn, { redirect: 'manual' });
      // The cookie the address rides in, whole, inside what a browser keeps.
      for (const cookie of started.headers.getSetCookie()) expect(cookie.split(';')[0]!.length).toBeLessThan(4_096);
      const asked = new URL(started.headers.get('location')!);
      issuerWillIdentify({ email: 'michael@example.com', nonce: asked.searchParams.get('nonce')! });
      const signedIn = await SELF.fetch(
        `${ORIGIN}/v1/sign-in/google/callback?code=a-code&state=${asked.searchParams.get('state')}`,
        { headers: { cookie: cookiesFrom(started).join('; ') }, redirect: 'manual' },
      );
      expect(signedIn.headers.get('location')).toBe(path);

      const session = cookiesFrom(signedIn).find((c) => c.startsWith('cockpit_session='))!;
      const shown = await SELF.fetch(`${ORIGIN}${signedIn.headers.get('location')}`, { headers: { cookie: session } });
      expect(shown.status).toBe(200);
      expect(await shown.text()).toContain('Allow Claude to create items in your Cockpit?');
    });

    it('asks somebody not signed in to sign in first, where the request is too long to bring back', async () => {
      const { path } = await attempt(await registerApp(), CALLBACK, 's'.repeat(3_500));
      const unsigned = await SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
      expect(unsigned.status).toBe(200);
      expect(await unsigned.text()).toContain('Sign in to Cockpit first');
    });

    it('refuses the guest, and says to sign in with Google', async () => {
      const { path } = await attempt(await registerApp());
      const guest = await SELF.fetch(`${ORIGIN}/v1/sign-in/guest`, { redirect: 'manual' });
      const cookie = cookiesFrom(guest).find((c) => c.startsWith('cockpit_session='))!;

      const shown = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });
      expect(shown.status).toBe(403);
      const page = await shown.text();
      expect(page).toContain('Sign in with Google to connect an app');
      expect(page).not.toContain('name="handle"');
    });

    it('refuses, before showing anything, an address the app never registered', async () => {
      const app = await registerApp();
      const { path } = await attempt(app, 'https://somewhere-else.example/steal');
      const shown = await SELF.fetch(`${ORIGIN}${path}`, {
        headers: { cookie: await signInAs(USER_ID) },
        redirect: 'manual',
      });
      expect(shown.status).toBe(400);
      expect(shown.headers.get('location')).toBeNull();
      expect(await shown.text()).not.toContain('name="handle"');
    });

    it('comes back from signing in only to the consent page', async () => {
      const elsewhere = ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/.//evil.example/', `/w/${WORKSPACE_ID}`];
      for (const target of elsewhere) {
        await issuerIsReachable();
        const started = await SELF.fetch(
          `${ORIGIN}/v1/sign-in/google?${new URLSearchParams({ return: target })}`,
          { redirect: 'manual' },
        );
        const asked = new URL(started.headers.get('location')!);
        issuerWillIdentify({ email: 'michael@example.com', nonce: asked.searchParams.get('nonce')! });
        const back = await SELF.fetch(
          `${ORIGIN}/v1/sign-in/google/callback?code=a-code&state=${asked.searchParams.get('state')}`,
          { headers: { cookie: cookiesFrom(started).join('; ') }, redirect: 'manual' },
        );
        expect([target, back.headers.get('location')]).toEqual([target, '/']);
      }
    });
  });

  describe('an app acts as the person who allowed it, looked up again on every capture', () => {
    it('captures into their account while they are still there', async () => {
      const { token } = await connected(OTHER_USER_ID);
      const said = await createItem(token, { message: 'Book the dentist' });
      expect(said.isError).toBeFalsy();
      const inbox = await inboxOf(WORKSPACE_ID, OTHER_USER_ID);
      expect(inbox.map((item) => item.capturedMessage)).toContain('Book the dentist');
    });

    it('is turned away once their access has been taken away', async () => {
      const { token } = await connected(OTHER_USER_ID);
      const disabled = await asUser(`${ORIGIN}/v1/admin/users/${OTHER_USER_ID}/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      });
      expect(disabled.status).toBe(200);

      const answer = await mcp(token, 'tools/call', { name: 'create_item', arguments: { message: 'Still here?' } });
      expect(answer.status).toBe(401);
    });

    it('cannot refresh its access once their access has been taken away, though it could before', async () => {
      const { app, refreshToken } = await connected(OTHER_USER_ID);
      const before = await refresh(app, refreshToken);
      expect(before.status).toBe(200);
      const { refresh_token: rotated } = (await before.json()) as { refresh_token: string };

      const disabled = await asUser(`${ORIGIN}/v1/admin/users/${OTHER_USER_ID}/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      });
      expect(disabled.status).toBe(200);

      const after = await refresh(app, rotated);
      expect(after.status).toBe(400);
      expect(((await after.json()) as { error: string }).error).toBe('invalid_grant');
      // Revoked with it, so giving the person access back does not revive it.
      expect(await grantsOf(OTHER_USER_ID)).toEqual([]);
    });

    it('stays cut off once their access is given back, though it never called while it was gone', async () => {
      const { app, token, refreshToken } = await connected(OTHER_USER_ID);
      for (const disabled of [true, false]) {
        const changed = await asUser(`${ORIGIN}/v1/admin/users/${OTHER_USER_ID}/access`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ disabled }),
        });
        expect(changed.status).toBe(200);
      }

      expect((await mcp(token, 'tools/list')).status).toBe(401);
      const refreshed = await refresh(app, refreshToken);
      expect(refreshed.status).toBe(400);
      expect(await grantsOf(OTHER_USER_ID)).toEqual([]);
    });

    it('takes their access away even where the apps they connected cannot be reached', async () => {
      const { token } = await connected(OTHER_USER_ID);
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
        expect(logged.mock.calls.some(([line]) => String(line).includes('were not revoked'))).toBe(true);
        // And the register still turns the app away.
        expect((await mcp(token, 'tools/list')).status).toBe(401);
      } finally {
        delete env.OAUTH_PROVIDER;
        logged.mockRestore();
      }
    });

    it('is turned away once they are deleted, and writes nothing for somebody new given their name', async () => {
      const { token } = await connected(OTHER_USER_ID);
      const deleted = await asUser(`${ORIGIN}/v1/admin/users/${OTHER_USER_ID}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      const added = await asUser(`${ORIGIN}/v1/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', email: 'ada.again@example.com' }),
      });
      // The same ids, which is the whole danger: a grant keyed on them alone
      // would now act for this person.
      expect(((await added.json()) as { user: { id: string } }).user.id).toBe(OTHER_USER_ID);
      const newcomer = await googleSignIn('ada.again@example.com');

      const answer = await mcp(token, 'tools/call', { name: 'create_item', arguments: { message: 'Whose is this?' } });
      expect(answer.status).toBe(401);
      const theirs = await SELF.fetch(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`, { headers: { cookie: newcomer } });
      expect(theirs.status).toBe(200);
      expect(besidesTheGuide(((await theirs.json()) as { items: Item[] }).items)).toEqual([]);
    });
  });
});

describe('Capture', () => {
  describe('a note an app captures lands exactly where the Capture page would put it', () => {
    it('waits in every Inbox with no Type when no workspace is named, with its clean-up and reading queued', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const queued: unknown[] = [];
      const realQueue = env.ENRICHMENT;
      env.ENRICHMENT = { send: async (job: unknown) => void queued.push(job) } as unknown as typeof env.ENRICHMENT;
      env.ANTHROPIC_API_KEY = 'a-key-nothing-reaches';
      env.EMBEDDINGS_STAND_IN = 'true';
      try {
        const said = await createItem(token, { message: 'Ring the plumber about the boiler' });
        expect(said.isError).toBeFalsy();
        await vi.waitFor(() => expect(queued).toHaveLength(2));
      } finally {
        env.ENRICHMENT = realQueue;
        env.ANTHROPIC_API_KEY = '';
        env.EMBEDDINGS_STAND_IN = '';
      }

      for (const workspaceId of [WORKSPACE_ID, 'ws-atlas', 'ws-personal']) {
        const item = (await inboxOf(workspaceId)).find((one) => one.capturedMessage === 'Ring the plumber about the boiler');
        expect(item, workspaceId).toMatchObject({ workspaceDecided: false });
      }
      expect(queued).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME }),
          expect.objectContaining({ accountName: ACCOUNT_NAME }),
        ]),
      );
    });

    it("lands in the named workspace's Inbox with no Type", async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const said = await createItem(token, { message: 'Send the quote', workspace: 'atlas copco' });
      expect(said.isError).toBeFalsy();

      const item = (await inboxOf('ws-atlas')).find((one) => one.capturedMessage === 'Send the quote');
      expect(item).toMatchObject({ workspaceId: 'ws-atlas', workspaceDecided: true });
      expect((await inboxOf('ws-personal')).some((one) => one.capturedMessage === 'Send the quote')).toBe(false);
    });

    const refusals = [
      { situation: 'a workspace there is no such one of', args: { message: 'Lost', workspace: 'Nowhere' }, names: 'Workspace 1' },
      { situation: 'a type, of any name', args: { message: 'Lost', type: 'Task' }, names: 'type is not an argument' },
      { situation: 'an empty message', args: { message: '   ' }, names: '60,000' },
      { situation: 'a message over 60,000 characters', args: { message: 'x'.repeat(60_001) }, names: '60,000' },
    ];

    it.each(refusals)('is refused, saying what would do, and writes nothing, for $situation', async ({ args, names }) => {
      const { token } = await connected();
      const said = await createItem(token, args);
      expect(said.isError).toBe(true);
      expect(said.content[0]!.text).toContain(names);
      expect(await inboxOf(WORKSPACE_ID)).toEqual([]);
    });

    it('still answers that it captured, with the title and the link, when the Item cannot be read back', async () => {
      const { token } = await connected();
      const realStores = env.ACCOUNT;
      env.ACCOUNT = {
        idFromName: (name: string) => realStores.idFromName(name),
        get: (id: ReturnType<typeof realStores.idFromName>) => {
          const real = realStores.get(id) as unknown as Record<string, (...args: unknown[]) => unknown>;
          return new Proxy(
            {},
            {
              get: (_, method: string) =>
                method === 'item'
                  ? async () => {
                      throw new Error('read back failed');
                    }
                  : (...args: unknown[]) => real[method]!(...args),
            },
          );
        },
      } as unknown as typeof env.ACCOUNT;
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      let said: ToolAnswer;
      try {
        said = await createItem(token, { message: 'Water the plants', workspace: 'Workspace 1' });
      } finally {
        env.ACCOUNT = realStores;
        logged.mockRestore();
      }
      const [item] = await inboxOf(WORKSPACE_ID);
      expect(said.isError).toBeFalsy();
      expect(said.content[0]!.text).toContain('"Water the plants"');
      expect(said.content[0]!.text).toContain(`${ORIGIN}/w/${WORKSPACE_ID}?item=${item!.id}`);
    });

    it('answers with the title and a link that opens the Item, and the Item says which app captured it', async () => {
      const { token } = await connected(USER_ID, 'Claude');
      const said = await createItem(token, { message: 'Water the plants', workspace: 'Workspace 1' });
      const [item] = await inboxOf(WORKSPACE_ID);

      expect(said.content[0]!.text).toContain(`"${item!.title}"`);
      expect(said.content[0]!.text).toContain(`${ORIGIN}/w/${WORKSPACE_ID}?item=${item!.id}`);
      expect([item!.source, item!.sender]).toEqual(['mcp', 'Claude']);
    });
  });

  describe("an app is told the person's own workspaces, as they are now", () => {
    it("names all of somebody's workspaces, and no Types, and nothing of another account's", async () => {
      await alsoWorkspaces();
      const { token } = await connected(OTHER_USER_ID);
      // Michael's three, which Ada's app must never be told about.
      const tool = await listedTool(token);
      expect(tool.inputSchema.properties.workspace!.enum).toEqual(['Workspace 1']);
      expect(tool.description).not.toContain('Atlas Copco');

      const own = await listedTool((await connected(USER_ID)).token);
      expect(own.inputSchema.properties.workspace!.enum).toEqual(['Workspace 1', 'Atlas Copco', 'Personal']);
      expect(own.description).toContain('"Atlas Copco"');
      expect(own.inputSchema.properties).not.toHaveProperty('type');
      expect(own.description).not.toContain('Task');
    });

    it('names a workspace by its new name once it is renamed', async () => {
      const { token } = await connected();
      await listedTool(token);
      const renamed = await asUser(`${ORIGIN}/v1/commands/rename_workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          name: 'Home',
        }),
      });
      expect(renamed.status).toBe(200);
      expect((await listedTool(token)).inputSchema.properties.workspace!.enum).toEqual(['Home']);
    });

    it('is still offered to somebody with no workspace, and says to make one when used', async () => {
      const { token } = await connected();
      const gone = await asUser(`${ORIGIN}/v1/commands/delete_workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId: WORKSPACE_ID }),
      });
      expect(gone.status).toBe(200);

      const tool = await listedTool(token);
      expect(tool.inputSchema.properties.workspace!.enum).toBeUndefined();
      const said = await createItem(token, { message: 'Somewhere to go' });
      expect(said.isError).toBe(true);
      expect(said.content[0]!.text).toContain('no workspace');
    });
  });

  describe('an app may ask to capture at most 60 times a minute', () => {
    it('refuses the 61st in a minute and writes nothing for it', async () => {
      const { token } = await connected();
      for (let n = 1; n <= 60; n += 1) {
        expect((await createItem(token, { message: `Note ${n}`, workspace: 'Workspace 1' })).isError, `note ${n}`).toBeFalsy();
      }
      const sixtyFirst = await createItem(token, { message: 'Note 61', workspace: 'Workspace 1' });
      expect(sixtyFirst.isError).toBe(true);
      expect(sixtyFirst.content[0]!.text).toContain('Too many');
      const held = (await inboxOf(WORKSPACE_ID)).map((item) => item.capturedMessage);
      expect([held.length, held.includes('Note 61')]).toEqual([60, false]);
    });
  });
});

/** The apps `userId` sees listed, as the settings window reads them. */
async function listedFor(userId: string = USER_ID): Promise<
  { id: string; name: string; connectedAt: string; lastCapturedAt: string | null }[]
> {
  const answer = await asUser(`${ORIGIN}/v1/connected-apps`, {}, userId);
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { apps: never[] }).apps;
}

describe('MCP connections', () => {
  describe('the list shows exactly the apps you allowed', () => {
    it('says nothing is connected where nothing is', async () => {
      expect(await listedFor()).toEqual([]);
    });

    it('lists your own app with when it was connected and, once it has, when it last captured', async () => {
      const { token } = await connected(USER_ID, 'Claude');
      const [before] = await listedFor();
      expect([before?.name, before?.lastCapturedAt]).toEqual(['Claude', null]);
      expect(Date.now() - Date.parse(before!.connectedAt)).toBeLessThan(60_000);

      expect((await createItem(token, { message: 'Water the plants' })).isError).toBeFalsy();
      // Noted after the answer is sent, so it can be a moment behind it.
      await vi.waitFor(async () => {
        const [after] = await listedFor();
        expect(after?.lastCapturedAt).not.toBeNull();
      });
    });

    it('does not list an app another person allowed', async () => {
      await connected(OTHER_USER_ID, 'Ada’s Claude');
      expect(await listedFor()).toEqual([]);
      expect((await listedFor(OTHER_USER_ID)).map((app) => app.name)).toEqual(['Ada’s Claude']);
    });
  });

  describe('disconnecting an app ends its access at once and keeps what it captured', () => {
    it('refuses its access and refresh tokens and leaves its Items', async () => {
      const { app, token, refreshToken } = await connected();
      expect((await createItem(token, { message: 'Kept after disconnecting' })).isError).toBeFalsy();
      const [listed] = await listedFor();

      const gone = await asUser(`${ORIGIN}/v1/connected-apps/${listed!.id}`, { method: 'DELETE' });
      expect(gone.status).toBe(200);

      expect((await mcp(token, 'tools/list')).status).toBe(401);
      expect((await refresh(app, refreshToken)).status).toBe(400);
      expect(await listedFor()).toEqual([]);
      expect((await inboxOf(WORKSPACE_ID)).map((item) => item.capturedMessage)).toContain('Kept after disconnecting');
    });

    it('leaves another person’s app alone, and says there is no such app of yours', async () => {
      const { token } = await connected(OTHER_USER_ID);
      const [theirs] = await listedFor(OTHER_USER_ID);

      const refused = await asUser(`${ORIGIN}/v1/connected-apps/${theirs!.id}`, { method: 'DELETE' });
      expect(refused.status).toBe(404);
      expect((await mcp(token, 'tools/list')).status).toBe(200);
    });

    it('is for somebody signed in', async () => {
      const answer = await SELF.fetch(`${ORIGIN}/v1/connected-apps`);
      expect(answer.status).toBe(401);
    });
  });
});


/** An Item captured and sent to Cowork as `userId`; the Run's id is the one the prompt names. */
async function aSentRun(userId: string = USER_ID): Promise<{ runId: string; itemId: string }> {
  const itemId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const post = (name: string, body: Record<string, unknown>) =>
    asUser(
      `${ORIGIN}/v1/commands/${name}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          ...body,
        }),
      },
      userId,
    );
  expect((await post('capture_item', { itemId, message: 'Draft the reply to the landlord' })).status).toBe(200);
  expect((await post('send_item_to_claude', { itemId, runId, destination: 'cowork', folder: '' })).status).toBe(200);
  return { runId, itemId };
}

async function reportRun(token: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: 'report_run', arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

async function theRun(runId: string, userId: string = USER_ID): Promise<AgentRun | undefined> {
  const answer = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`, {}, userId);
  return ((await answer.json()) as WorkspaceSnapshot).agentRuns.find((run) => run.id === runId);
}

const reportsLogged = () =>
  inTheStore((sql) => [...sql.exec("SELECT command_id FROM commands WHERE name = 'report_claude_run'")].length);

const SESSION = 'https://claude.ai/code/session_01ABC';

describe('Agents', () => {
  describe('a report moves the Run through its stages, from Sent', () => {
    it('stores on it with the session link', async () => {
      const { token } = await connected();
      const { runId } = await aSentRun();

      const said = await reportRun(token, { run: runId, stage: 'on_it', session_url: SESSION });

      expect(said.isError).toBeFalsy();
      expect(await theRun(runId)).toMatchObject({ stage: 'on_it', sessionUrl: SESSION, destination: 'cowork' });
    });

    it('stores ready with the result link and the note', async () => {
      const { token } = await connected();
      const { runId } = await aSentRun();
      await reportRun(token, { run: runId, stage: 'on_it', session_url: SESSION });

      await reportRun(token, { run: runId, stage: 'ready', result_url: 'https://example.com/draft', note: 'Two drafts, A and B' });

      expect(await theRun(runId)).toMatchObject({
        stage: 'ready',
        sessionUrl: SESSION,
        resultUrl: 'https://example.com/draft',
        note: 'Two drafts, A and B',
      });
    });

    it('stores needs you with its question', async () => {
      const { token } = await connected();
      const { runId } = await aSentRun();

      await reportRun(token, { run: runId, stage: 'needs_you', note: 'Which tenancy is it?' });

      expect(await theRun(runId)).toMatchObject({ stage: 'needs_you', note: 'Which tenancy is it?' });
    });

    it('goes back to on it when Claude picks it up again after an answer', async () => {
      const { token } = await connected();
      const { runId } = await aSentRun();
      await reportRun(token, { run: runId, stage: 'ready', result_url: 'https://example.com/draft', note: 'Done' });

      await reportRun(token, { run: runId, stage: 'on_it' });

      expect(await theRun(runId)).toMatchObject({ stage: 'on_it', note: null });
    });

    it('is one change, announced once, when the same report arrives twice', async () => {
      const { token } = await connected();
      const { runId } = await aSentRun();
      const before = await reportsLogged();

      const report = { run: runId, stage: 'ready', result_url: 'https://example.com/draft', note: 'Done' };
      const first = await reportRun(token, report);
      const second = await reportRun(token, report);

      expect([first.isError, second.isError]).toEqual([undefined, undefined]);
      expect((await reportsLogged()) - before).toBe(1);
    });
  });

  describe('only the person’s own open Runs can be reported on, and nothing else on the Item changes', () => {
    const noRun = 'There is no open run with that id';

    it('refuses an id that is no Run of theirs, in words the model can act on', async () => {
      const { token } = await connected();

      const said = await reportRun(token, { run: crypto.randomUUID(), stage: 'on_it' });

      expect(said).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(noRun) }] });
    });

    it('refuses another account’s Run in the same words, and leaves it as it was', async () => {
      const { token } = await connected();
      const theirs = await aSentRun(OTHER_USER_ID);
      const unknown = await reportRun(token, { run: crypto.randomUUID(), stage: 'ready' });

      const said = await reportRun(token, { run: theirs.runId, stage: 'ready', note: 'Mine now' });

      expect(said).toEqual(unknown);
      expect(await theRun(theirs.runId, OTHER_USER_ID)).toMatchObject({ stage: 'sent', note: null });
    });

    it('refuses a Run the Item’s Status has ended', async () => {
      const { token } = await connected();
      const { runId, itemId } = await aSentRun();
      const dismissed = await asUser(`${ORIGIN}/v1/commands/set_dismissed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          itemId,
          dismissed: true,
        }),
      });
      expect(dismissed.status).toBe(200);

      const said = await reportRun(token, { run: runId, stage: 'ready' });

      expect(said).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(noRun) }] });
    });

    it('turns away an app whose grant was revoked', async () => {
      const { token } = await connected();
      const { runId } = await aSentRun();
      const [listed] = await listedFor();
      expect((await asUser(`${ORIGIN}/v1/connected-apps/${listed!.id}`, { method: 'DELETE' })).status).toBe(200);

      const answer = await mcp(token, 'tools/call', { name: 'report_run', arguments: { run: runId, stage: 'ready' } });

      expect(answer.status).toBe(401);
      expect(await theRun(runId)).toMatchObject({ stage: 'sent' });
    });
  });

  describe('a link is stored only where it is safe to open', () => {
    it.each([
      { situation: 'a session link off claude.ai', args: { session_url: 'https://example.com/s' } },
      { situation: 'a file result link', args: { result_url: 'file:///C:/secret.txt' } },
      { situation: 'a javascript result link', args: { result_url: 'javascript:alert(1)' } },
      { situation: 'a plain http result link', args: { result_url: 'http://example.com/x' } },
      { situation: 'a link over 2,048 characters', args: { result_url: 'https://example.com/' + 'a'.repeat(2_048) } },
    ])('refuses $situation and writes nothing', async ({ args }) => {
      const { token } = await connected();
      const { runId } = await aSentRun();

      const said = await reportRun(token, { run: runId, stage: 'ready', ...args });

      expect(said.isError).toBe(true);
      expect(await theRun(runId)).toMatchObject({ stage: 'sent', sessionUrl: null, resultUrl: null });
    });
  });

  describe('an app may report at most 60 times a minute, as it may capture', () => {
    it('refuses the 61st in a minute, and admits the next minute', async () => {
      const { token } = await connected();
      const { runId } = await aSentRun();
      for (let n = 1; n <= 60; n += 1) {
        expect((await reportRun(token, { run: runId, stage: 'on_it' })).isError, `report ${n}`).toBeFalsy();
      }

      const sixtyFirst = await reportRun(token, { run: runId, stage: 'ready' });
      expect(sixtyFirst.isError).toBe(true);
      expect(sixtyFirst.content[0]!.text).toContain('Too many');
      expect(await theRun(runId)).toMatchObject({ stage: 'on_it' });

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
      expect((await reportRun(token, { run: runId, stage: 'ready' })).isError).toBeFalsy();
    });
  });
});

/**
 * "Find items in Cockpit from a connected app, over MCP" (issue 1240). The
 * Items are made the ways a person's own Cockpit makes them - commands for
 * capturing, filing and changing - and the app asks through `/mcp`; how a
 * search is read and worded is tests/unit/mcp/find-items.test.ts's.
 */
async function change(
  name: string,
  payload: Record<string, unknown>,
  userId: string = USER_ID,
  workspaceId: string = WORKSPACE_ID,
): Promise<void> {
  const answer = await asUser(
    `${ORIGIN}/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId, ...payload }),
    },
    userId,
  );
  expect(answer.status, `${name}: ${await answer.clone().text()}`).toBe(200);
}

/** Captures an Item into a workspace, answering its id. */
async function captured(
  message: string,
  fields: { workspaceId?: string; userId?: string } = {},
): Promise<string> {
  const itemId = crypto.randomUUID();
  await change('capture_item', { itemId, message }, fields.userId ?? USER_ID, fields.workspaceId ?? WORKSPACE_ID);
  return itemId;
}

/** A Panel of the given kind on a Dashboard, answering its id. */
async function panelOn(
  dashboardId: string,
  name: string,
  kind: 'items' | 'filter' = 'items',
  workspaceId: string = WORKSPACE_ID,
): Promise<string> {
  const panelId = crypto.randomUUID();
  await change('add_panel', { dashboardId, panelId, name, kind }, USER_ID, workspaceId);
  return panelId;
}

/** What each Panel holds so far, since filing onto one names the Panel's whole order. */
const filedSoFar = new Map<string, string[]>();

async function fileOn(itemId: string, panelId: string, workspaceId: string = WORKSPACE_ID): Promise<void> {
  const order = [itemId, ...(filedSoFar.get(panelId) ?? [])];
  await change('add_item_to_panel', { itemId, panelId, order }, USER_ID, workspaceId);
  filedSoFar.set(panelId, order);
}

/** Says when an Item last changed, so the order a result comes in is the case's own. */
async function changedAt(itemId: string, updatedAt: string): Promise<void> {
  await inTheStore((sql) => void sql.exec('UPDATE items SET updated_at = ? WHERE id = ?', updatedAt, itemId));
}

async function findItems(token: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: 'find_items', arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

/** The titles of a reply's results, in the order it gave them. */
function titlesOf(answer: ToolAnswer): string[] {
  return answer.content[0]!.text.split('\n').flatMap((line) => /^\d+\. (.+) \((?:To do|In progress|Done), /.exec(line)?.[1] ?? []);
}

const cursorOf = (answer: ToolAnswer): string | undefined => /cursor "([^"]+)"/.exec(answer.content[0]!.text)?.[1];

describe('MCP connections', () => {
  describe('an app finds the open items that hold its text, in every workspace of its own account', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('matches the title, description, next action and sender, ignoring case, and says so plainly when nothing matches', async () => {
      const { token } = await connected(USER_ID, 'Zed Assistant');
      await captured('Pay the Dentist');
      const described = await captured('Book travel');
      await change('set_description', { itemId: described, description: 'about the DENTIST bill' });
      const nextAction = await captured('Call back');
      await change('set_next_action', { itemId: nextAction, nextAction: 'dentist asap' });
      await createItem(token, { message: 'Water plants' });
      await captured('Rent');

      expect(titlesOf(await findItems(token, { text: 'dentist' })).sort()).toEqual(['Book travel', 'Call back', 'Pay the Dentist']);
      // Only the app's own name, which is the sender of what it captured.
      expect(titlesOf(await findItems(token, { text: 'zed ass' }))).toEqual(['Water plants']);
      const none = await findItems(token, { text: 'nothing like this' });
      expect(none).toEqual({ content: [{ type: 'text', text: 'No item matches.' }] });
    });

    it('lists every open item, most recently changed first, when nothing is asked', async () => {
      const { token } = await connected();
      const oldest = await captured('Oldest');
      const newest = await captured('Newest');
      const middle = await captured('Middle');
      await changedAt(oldest, '2026-10-01T08:00:00.000Z');
      await changedAt(middle, '2026-10-05T08:00:00.000Z');
      await changedAt(newest, '2026-10-09T08:00:00.000Z');

      expect(titlesOf(await findItems(token))).toEqual(['Newest', 'Middle', 'Oldest']);
    });

    it('narrows to the workspace named, in any case, and combines with priority and text', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const home = await captured('Invoice for the roof');
      const atlasHigh = await captured('Invoice for Atlas', { workspaceId: 'ws-atlas' });
      const atlasLow = await captured('Invoice for the canteen', { workspaceId: 'ws-atlas' });
      await captured('Meeting notes', { workspaceId: 'ws-atlas' });
      await change('set_priority', { itemId: atlasHigh, priority: 'high' }, USER_ID, 'ws-atlas');
      await change('set_priority', { itemId: atlasLow, priority: 'low' }, USER_ID, 'ws-atlas');
      await change('set_priority', { itemId: home, priority: 'high' });

      expect(titlesOf(await findItems(token, { workspace: 'atlas copco', text: 'invoice' })).sort()).toEqual([
        'Invoice for Atlas',
        'Invoice for the canteen',
      ]);
      expect(titlesOf(await findItems(token, { workspace: 'ATLAS COPCO', priority: 'high', text: 'invoice' }))).toEqual([
        'Invoice for Atlas',
      ]);
      expect(titlesOf(await findItems(token, { priority: 'high' })).sort()).toEqual(['Invoice for Atlas', 'Invoice for the roof']);
    });

    it('refuses a workspace there is none of, listing the workspaces', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const said = await findItems(token, { workspace: 'Nowhere' });
      expect(said.isError).toBe(true);
      expect(said.content[0]!.text).toContain('"Workspace 1", "Atlas Copco", "Personal"');
    });
  });

  describe('an app finds finished items only when asked, and a dismissed one never', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('leaves out the finished without include_done, lists them marked Done with it, and never lists the dismissed', async () => {
      const { token } = await connected();
      await captured('Still to do');
      const finished = await captured('Already done');
      const dismissed = await captured('Thrown away');
      await change('set_done', { itemId: finished, done: true });
      await change('set_dismissed', { itemId: dismissed, dismissed: true });

      expect(titlesOf(await findItems(token))).toEqual(['Still to do']);
      const withDone = await findItems(token, { include_done: true });
      expect(titlesOf(withDone).sort()).toEqual(['Already done', 'Still to do']);
      expect(withDone.content[0]!.text).toContain('Already done (Done, ');
      expect(withDone.content[0]!.text).not.toContain('Thrown away');
    });

    it('refuses a done status asked for without include_done, saying so', async () => {
      const { token } = await connected();
      const said = await findItems(token, { status: 'done' });
      expect(said.isError).toBe(true);
      expect(said.content[0]!.text).toContain('include_done');
    });
  });

  describe('an app finds across every workspace of its own account and nothing of another’s', () => {
    beforeEach(async () => {
      await withoutTheGuide();
      await withoutTheGuide('tenant-ada');
    });

    it('returns matches in two workspaces when none is named, and never the other account’s item', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await captured('Dentist in Workspace 1');
      await captured('Dentist at Atlas', { workspaceId: 'ws-atlas' });
      await captured('Dentist, somebody else’s', { userId: OTHER_USER_ID });

      expect(titlesOf(await findItems(token, { text: 'dentist' })).sort()).toEqual([
        'Dentist at Atlas',
        'Dentist in Workspace 1',
      ]);
    });
  });

  describe('an app finds nothing of a workspace that was deleted, though its items and panels are still stored', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('does not return its items or offer its panels, and still finds the live workspaces’ own', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const gonePanel = await panelOn('ws-atlas-dashboard-1', 'Calls', 'items', 'ws-atlas');
      await fileOn(await captured('Dentist at Atlas', { workspaceId: 'ws-atlas' }), gonePanel, 'ws-atlas');
      await captured('Dentist at home');
      expect(titlesOf(await findItems(token, { text: 'dentist' })).sort()).toEqual(['Dentist at Atlas', 'Dentist at home']);

      await change('delete_workspace', {}, USER_ID, 'ws-atlas');

      const found = await findItems(token, { text: 'dentist' });
      expect(titlesOf(found)).toEqual(['Dentist at home']);
      expect(found.content[0]!.text).not.toMatch(/Workspace: *\n/);
      expect(titlesOf(await findItems(token))).toEqual(['Dentist at home']);
      const asked = await findItems(token, { panel: 'Calls' });
      expect(asked.isError).toBe(true);
      expect(asked.content[0]!.text).toContain('No panel is called "Calls"');
      expect(asked.content[0]!.text).not.toContain('"Calls", ');
    });
  });

  describe('an app naming a workspace finds that workspace’s own items, and an undecided item only where nothing is named', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('leaves an item waiting in every Inbox out of another workspace’s results, and out of the whole account’s no more', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      // No workspace named: undecided, though recorded against the first one.
      await createItem(token, { message: 'Waiting in every inbox' });
      await captured('Decided at Atlas', { workspaceId: 'ws-atlas' });

      expect(titlesOf(await findItems(token)).sort()).toEqual(['Decided at Atlas', 'Waiting in every inbox']);
      expect(titlesOf(await findItems(token, { workspace: 'Atlas Copco' }))).toEqual(['Decided at Atlas']);
      expect(titlesOf(await findItems(token, { workspace: 'Personal' }))).toEqual([]);
      // Named for the workspace it was captured from, it is that workspace's.
      const own = await findItems(token, { workspace: 'Workspace 1' });
      expect(titlesOf(own)).toEqual(['Waiting in every inbox']);
      expect(own.content[0]!.text).toContain('Workspace: Workspace 1');
    });
  });

  describe('each result says where the item is and what it holds', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('names every panel an item is filed on as Workspace ▸ Dashboard ▸ Panel, and Inbox for one never filed', async () => {
      const { token } = await connected();
      const filed = await captured('Filed twice');
      await captured('Never filed');
      const admin = await panelOn(DASHBOARD_ID, 'Admin');
      const calls = await panelOn(DASHBOARD_ID, 'Calls');
      await fileOn(filed, admin);
      await fileOn(filed, calls);

      const said = (await findItems(token)).content[0]!.text;
      expect(said).toContain('Where: Workspace 1 ▸ Dashboard 1 ▸ Admin; Workspace 1 ▸ Dashboard 1 ▸ Calls');
      expect(said).toContain('Where: Inbox');
      expect(said).toContain(`Open in Cockpit: ${ORIGIN}/w/${WORKSPACE_ID}?item=${filed}`);
    });

    it('gives the title, description whole, next action, status, priority, due date and sender', async () => {
      const { token } = await connected();
      const itemId = await captured('Send the quote');
      const description = `${'A long paragraph about the quote. '.repeat(60)}\nSecond paragraph.`;
      await change('set_description', { itemId, description });
      await change('set_next_action', { itemId, nextAction: 'Ring Sam' });
      await change('set_priority', { itemId, priority: 'high' });
      await change('set_due_date', { itemId, dueDate: '2026-10-20' });
      await change('set_started', { itemId, started: true });

      const said = (await findItems(token, { text: 'quote' })).content[0]!.text;
      expect(said).toContain('1. Send the quote (In progress, High priority, due 2026-10-20)');
      expect(said).toContain('Next action: Ring Sam');
      expect(said).toContain('A long paragraph about the quote. '.repeat(60).trimEnd());
      expect(said).toContain('   Second paragraph.');
    });
  });

  describe('an app finds the items on a panel by the panel’s name', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('finds the items filed on a panel of that name, and those a filter panel of that name gathers as the screen shows them', async () => {
      const { token } = await connected();
      const admin = await panelOn(DASHBOARD_ID, 'Admin');
      const urgent = await panelOn(DASHBOARD_ID, 'Urgent', 'filter');
      await change('set_panel_filter', {
        panelId: urgent,
        rows: [[{ field: 'priority', values: ['high'] }]],
        groupBy: 'none',
      });
      const filedHigh = await captured('Filed and high');
      const filedLow = await captured('Filed and low');
      const unfiledHigh = await captured('Unfiled and high');
      for (const itemId of [filedHigh, filedLow]) await fileOn(itemId, admin);
      await change('set_priority', { itemId: filedHigh, priority: 'high' });
      await change('set_priority', { itemId: unfiledHigh, priority: 'high' });

      expect(titlesOf(await findItems(token, { panel: 'admin' })).sort()).toEqual(['Filed and high', 'Filed and low']);
      expect(titlesOf(await findItems(token, { panel: 'URGENT' }))).toEqual(['Filed and high']);
    });

    it('finds the items of two panels of one name on different dashboards, or of the one in the workspace named', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const home = await panelOn(DASHBOARD_ID, 'Calls');
      const atlas = await panelOn('ws-atlas-dashboard-1', 'Calls', 'items', 'ws-atlas');
      await fileOn(await captured('Home call'), home);
      const atlasCall = await captured('Atlas call', { workspaceId: 'ws-atlas' });
      await fileOn(atlasCall, atlas, 'ws-atlas');

      expect(titlesOf(await findItems(token, { panel: 'Calls' })).sort()).toEqual(['Atlas call', 'Home call']);
      expect(titlesOf(await findItems(token, { panel: 'Calls', workspace: 'Atlas Copco' }))).toEqual(['Atlas call']);
    });
  });

  describe('an app reads 25 items a page, newest change first, and the cursor repeats and skips nothing', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('gives 25 and says more follow with a cursor, whose page gives the 26th and no cursor', async () => {
      const { token } = await connected();
      const ids: string[] = [];
      for (let n = 1; n <= 26; n += 1) ids.push(await captured(`Note ${String(n).padStart(2, '0')}`));
      await Promise.all(ids.map((id, at) => changedAt(id, `2026-10-${String(1 + at).padStart(2, '0')}T08:00:00.000Z`)));

      const first = await findItems(token);
      const cursor = cursorOf(first);
      expect(titlesOf(first)).toHaveLength(25);
      expect(titlesOf(first)[0]).toBe('Note 26');
      expect(first.content[0]!.text).toContain('More items follow');
      expect(cursor).toBeTruthy();

      const second = await findItems(token, { cursor });
      expect(titlesOf(second)).toEqual(['Note 01']);
      expect(cursorOf(second)).toBeUndefined();
    });

    it('returns each of two items changed at the same moment once, with the page edge between them', async () => {
      const { token } = await connected();
      const ids: string[] = [];
      for (let n = 1; n <= 26; n += 1) ids.push(await captured(`Same moment ${n}`));
      await Promise.all(ids.map((id) => changedAt(id, '2026-10-12T08:00:00.000Z')));

      const first = await findItems(token);
      const second = await findItems(token, { cursor: cursorOf(first) });
      const seen = [...titlesOf(first), ...titlesOf(second)];
      expect(seen).toHaveLength(26);
      expect(new Set(seen).size).toBe(26);
    });

    it('refuses a cursor Cockpit did not give, in words', async () => {
      const { token } = await connected();
      const said = await findItems(token, { cursor: 'something-else' });
      expect(said).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('not one Cockpit gave') }] });
    });
  });

  describe('a plain search reads no panels, and one naming a panel says plainly when they cannot be read', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    it('answers a search naming no panel though the panels could not be read, and apologises for one that names one', async () => {
      const { token } = await connected();
      await captured('Ring the dentist');
      const realStores = env.ACCOUNT;
      env.ACCOUNT = {
        idFromName: (name: string) => realStores.idFromName(name),
        get: (id: ReturnType<typeof realStores.idFromName>) => {
          const real = realStores.get(id) as unknown as Record<string, (...args: unknown[]) => unknown>;
          return new Proxy(
            {},
            {
              get: (_, method: string) =>
                method === 'itemPanels'
                  ? async () => {
                      throw new Error('panels unreadable: disk on fire');
                    }
                  : (...args: unknown[]) => real[method]!(...args),
            },
          );
        },
      } as unknown as typeof env.ACCOUNT;
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(titlesOf(await findItems(token, { text: 'dentist' }))).toEqual(['Ring the dentist']);
        const naming = await findItems(token, { panel: 'Admin' });
        expect(naming).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Something went wrong in Cockpit') }] });
        expect(JSON.stringify(naming)).not.toContain('disk on fire');
      } finally {
        env.ACCOUNT = realStores;
        logged.mockRestore();
      }
    });
  });

  describe('an app may find 10 times a minute, apart from its limit to capture', () => {
    it('refuses the 11th call inside a minute, saying to wait, and still lets it capture', async () => {
      const { token } = await connected();
      for (let n = 1; n <= 10; n += 1) expect((await findItems(token)).isError, `find ${n}`).toBeFalsy();
      const eleventh = await findItems(token);
      expect(eleventh.isError).toBe(true);
      expect(eleventh.content[0]!.text).toContain('Wait a minute');
      expect((await createItem(token, { message: 'Captured all the same' })).isError).toBeFalsy();
    });

    it('counts each app’s grant apart', async () => {
      const first = await connected(USER_ID, 'Claude');
      const second = await connected(USER_ID, 'Another app');
      for (let n = 1; n <= 10; n += 1) await findItems(first.token);
      expect((await findItems(first.token)).isError).toBe(true);
      expect((await findItems(second.token)).isError).toBeFalsy();
    });
  });

  describe('an app is told, on the consent page and in its tools, that it can read items', () => {
    it('lists find_items naming this account’s workspaces, and nothing of another account’s', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const answer = await mcp(token, 'tools/list');
      const { tools } = ((await answer.json()) as { result: { tools: ListedTool[] } }).result;
      const find = tools.find((tool) => tool.name === 'find_items')!;
      expect(find.inputSchema.properties.workspace!.enum).toEqual(['Workspace 1', 'Atlas Copco', 'Personal']);
      expect(find.description).toContain('"Atlas Copco"');

      const others = await mcp((await connected(OTHER_USER_ID)).token, 'tools/list');
      const theirs = ((await others.json()) as { result: { tools: ListedTool[] } }).result.tools.find((tool) => tool.name === 'find_items')!;
      expect(theirs.inputSchema.properties.workspace!.enum).toEqual(['Workspace 1']);
    });
  });
});

describe('Agents', () => {
  describe('an app finds an item’s attachments by name, each with a link that opens the file without signing in', () => {
    beforeEach(async () => {
      await withoutTheGuide();
    });

    async function withAFile(itemId: string, filename = 'layout.png'): Promise<void> {
      const uploaded = await asUser(`${ORIGIN}/v1/items/${itemId}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-attachment-id': crypto.randomUUID(),
          'x-command-id': crypto.randomUUID(),
          'x-issued-at': new Date().toISOString(),
          'x-workspace-id': WORKSPACE_ID,
          'x-filename': filename,
        },
        body: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
      });
      expect(uploaded.status).toBe(201);
    }

    it('names the file with a link that gives its bytes to somebody holding no cookie, and lists none for an item with none', async () => {
      const { token } = await connected();
      await withAFile(await captured('Has a file'));
      await captured('Has none');

      const said = (await findItems(token)).content[0]!.text;
      const link = /layout\.png \((http[^)]+\/v1\/attachment-links\/[^)]+)\)/.exec(said)?.[1];
      expect(link).toBeTruthy();
      expect(said.match(/Attachments:/g)).toHaveLength(1);
      const opened = await SELF.fetch(link!);
      expect([opened.status, [...new Uint8Array(await opened.arrayBuffer())]]).toEqual([200, [137, 80, 78, 71, 1, 2, 3]]);
    });

    it('gives each of several files its own link that opens, across items too', async () => {
      const { token } = await connected();
      const first = await captured('Has two files');
      await withAFile(first, 'one.png');
      await withAFile(first, 'two.png');
      await withAFile(await captured('Has another'), 'three.png');

      const said = (await findItems(token)).content[0]!.text;
      const links = ['one.png', 'two.png', 'three.png'].map((name) => {
        const at = said.indexOf(`${name} (`);
        expect(at, name).toBeGreaterThanOrEqual(0);
        const link = said.slice(at + name.length + 2, said.indexOf(')', at));
        expect(link, name).toContain('/v1/attachment-links/');
        return link;
      });
      expect(new Set(links).size).toBe(3);
      for (const link of links) expect((await SELF.fetch(link)).status).toBe(200);
    });

    it('names the file alone where the environment has no key to seal a link with', async () => {
      const { token } = await connected();
      await withAFile(await captured('Has a file'));
      const key = env.CONNECTOR_CREDENTIAL_KEY;
      env.CONNECTOR_CREDENTIAL_KEY = '';
      try {
        const said = (await findItems(token)).content[0]!.text;
        expect(said).toContain('Attachments: layout.png\n');
        expect(said).not.toContain('attachment-links');
      } finally {
        env.CONNECTOR_CREDENTIAL_KEY = key!;
      }
    });
  });
});

describe('Appearance', () => {
  describe('in light, the page is one grey wherever it is drawn', () => {
    it('draws the page an app is asked to be allowed on the one light page grey', async () => {
      const app = await registerApp('Claude');
      const { path } = await attempt(app);
      const shown = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie: await signInAs(USER_ID) } });

      expect(await shown.text()).toContain(`background: ${NEUTRAL_GROUND};`);
    });
  });
});
