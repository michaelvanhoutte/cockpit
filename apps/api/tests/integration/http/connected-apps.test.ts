import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import type { Item } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  signInAs,
  startFromEmpty,
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
async function attempt(app: App, redirect = CALLBACK) {
  const verifier = 'v'.repeat(43) + crypto.randomUUID().replaceAll('-', '');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: redirect,
    state: 'the-apps-state',
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
  description: string;
  inputSchema: { properties: Record<string, { enum?: string[] }> };
}

async function listedTool(token: string): Promise<ListedTool> {
  const answer = await mcp(token, 'tools/list');
  expect(answer.status).toBe(200);
  const { tools } = ((await answer.json()) as { result: { tools: ListedTool[] } }).result;
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

/** Every Item a workspace's Inbox shows, as the app reads it. */
async function inboxOf(workspaceId: string, userId: string = USER_ID): Promise<Item[]> {
  const answer = await asUser(`${ORIGIN}/v1/workspaces/${workspaceId}/snapshot`, {}, userId);
  return ((await answer.json()) as { items: Item[] }).items;
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

describe('Connected apps', () => {
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

  describe('an app is never told what broke inside Cockpit, and the break is logged', () => {
    it('answers listing and capturing with a plain apology when the account cannot be read', async () => {
      const { token } = await connected();
      const realStores = env.ACCOUNT;
      const broken = async () => {
        throw new Error('tenant-default could not be brought up to date: disk on fire');
      };
      env.ACCOUNT = {
        idFromName: (name: string) => realStores.idFromName(name),
        get: () => ({ workspaces: broken, itemTypes: broken, appCaptureArrived: broken }),
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

    it('walks somebody not signed in through Google sign-in and back to the consent page', async () => {
      const { path } = await attempt(await registerApp());
      const unsigned = await SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
      expect(unsigned.status).toBe(302);
      const toSignIn = new URL(unsigned.headers.get('location')!, ORIGIN);
      expect(toSignIn.pathname).toBe('/v1/sign-in/google');

      await issuerIsReachable();
      const started = await SELF.fetch(toSignIn, { redirect: 'manual' });
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

    it('comes back from signing in only to a path on Cockpit itself', async () => {
      const elsewhere = ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/.//evil.example/'];
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
      expect(((await theirs.json()) as { items: Item[] }).items).toEqual([]);
    });
  });
});

describe('Capture', () => {
  describe('a note an app captures lands exactly where the Capture page would put it', () => {
    it('waits in every Inbox as a Note when no workspace or type is named, with its clean-up and reading queued', async () => {
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
        expect(item, workspaceId).toMatchObject({ workspaceDecided: false, typeId: `${ACCOUNT_NAME}-type-thought` });
      }
      expect(queued).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME }),
          expect.objectContaining({ accountName: ACCOUNT_NAME }),
        ]),
      );
    });

    it("lands in the named workspace's Inbox as the named type", async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const said = await createItem(token, { message: 'Send the quote', workspace: 'atlas copco', type: 'Task' });
      expect(said.isError).toBeFalsy();

      const item = (await inboxOf('ws-atlas')).find((one) => one.capturedMessage === 'Send the quote');
      expect(item).toMatchObject({ workspaceId: 'ws-atlas', workspaceDecided: true, typeId: `${ACCOUNT_NAME}-type-action` });
      expect((await inboxOf('ws-personal')).some((one) => one.capturedMessage === 'Send the quote')).toBe(false);
    });

    const refusals = [
      { situation: 'a workspace there is no such one of', args: { message: 'Lost', workspace: 'Nowhere' }, names: 'Workspace 1' },
      { situation: 'a type there is no such one of', args: { message: 'Lost', type: 'Errand' }, names: 'Task' },
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

    it('answers with the title and a link that opens the Item, and the Item says which app captured it', async () => {
      const { token } = await connected(USER_ID, 'Claude');
      const said = await createItem(token, { message: 'Water the plants', workspace: 'Workspace 1' });
      const [item] = await inboxOf(WORKSPACE_ID);

      expect(said.content[0]!.text).toContain(`"${item!.title}"`);
      expect(said.content[0]!.text).toContain(`${ORIGIN}/w/${WORKSPACE_ID}?item=${item!.id}`);
      expect([item!.source, item!.sender]).toEqual(['mcp', 'Claude']);
    });
  });

  describe("an app is told the person's own workspaces and types, as they are now", () => {
    it("names both of somebody's workspaces and their types, and nothing of another account's", async () => {
      await alsoWorkspaces();
      const { token } = await connected(OTHER_USER_ID);
      // Michael's three, which Ada's app must never be told about.
      const tool = await listedTool(token);
      expect(tool.inputSchema.properties.workspace!.enum).toEqual(['Workspace 1']);
      expect(tool.description).not.toContain('Atlas Copco');

      const own = await listedTool((await connected(USER_ID)).token);
      expect(own.inputSchema.properties.workspace!.enum).toEqual(['Workspace 1', 'Atlas Copco', 'Personal']);
      expect(own.description).toContain('"Atlas Copco"');
      expect(own.inputSchema.properties.type!.enum).toEqual(expect.arrayContaining(['Task', 'Note']));
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

  describe('an app is answered at most 60 times a minute', () => {
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
