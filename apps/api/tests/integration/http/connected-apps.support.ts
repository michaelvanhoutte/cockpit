import { expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { USER_ID, signInAs } from '../seed.js';

/**
 * An app connecting to Cockpit the way a real one does - registering, the
 * consent page, the code exchange - for the files that prove what a grant may
 * then do (`connected-apps.test.ts`, `panel-reads.test.ts`). Everything enters
 * through `SELF.fetch`, because who is admitted and as whom is decided by the
 * routing in front of the application and the library behind it.
 */

export const ORIGIN = 'https://cockpit.test';
export const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** Where the widget app is sent back to: an address of its own on the phone (RFC 8252). */
export const WIDGET_CALLBACK = 'cockpit-widget://oauth';

/** The two protected resources an app signs in for: MCP, to capture, and the reads of Panels. */
export const MCP_RESOURCE = `${ORIGIN}/mcp`;
export const APPS_RESOURCE = `${ORIGIN}/apps`;

export interface App {
  clientId: string;
}

/** Registers an app the way Claude does, by dynamic registration. */
export async function registerApp(name = 'Claude', redirect = CALLBACK): Promise<App> {
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

/**
 * One authorization attempt: the address the app opens, and the secret it keeps
 * back. `resource` is the one it asks to be signed in for, `null` for an app
 * that names none.
 */
export async function attempt(
  app: App,
  redirect = CALLBACK,
  state = 'the-apps-state',
  resource: string | null = MCP_RESOURCE,
) {
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
    ...(resource ? { resource } : {}),
  });
  return { path: `/oauth/authorize?${query}`, verifier };
}

/** The cookies a response set, as a browser would send them back. */
export function cookiesFrom(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!).filter((c) => !c.endsWith('='));
}

/**
 * Opens the consent page as whoever holds `cookie`, and presses one of its two
 * buttons - as whoever holds `pressedWith` by then, which is the same person
 * unless a case says otherwise (`null` for nobody signed in at all).
 */
export async function decide(
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

/** The code an app's authorization attempt came back with, traded for access. */
export async function tradeCode(
  app: App,
  code: string,
  verifier: string,
  redirect = CALLBACK,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: app.clientId,
      code_verifier: verifier,
    }),
  });
}

/**
 * An app connected by `userId`: registered, allowed, and its code traded for
 * access. `reading` is an app that asks to be signed in for `/apps` and returns to
 * the address of its own, as the widget does; left out, an app as Claude is.
 */
export async function connected(
  userId: string = USER_ID,
  name = 'Claude',
  { reading = false }: { reading?: boolean } = {},
): Promise<{ app: App; token: string; refreshToken: string; resource: string }> {
  const redirect = reading ? WIDGET_CALLBACK : CALLBACK;
  const app = await registerApp(name, redirect);
  const asked = await attempt(app, redirect, 'the-apps-state', reading ? APPS_RESOURCE : MCP_RESOURCE);
  const allowed = await decide(asked.path, await signInAs(userId), 'allow');
  expect(allowed.status).toBe(302);
  const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
  const traded = await tradeCode(app, code, asked.verifier, redirect);
  expect(traded.status).toBe(200);
  const tokens = (await traded.json()) as { access_token: string; refresh_token: string; resource: string };
  return { app, token: tokens.access_token, refreshToken: tokens.refresh_token, resource: tokens.resource };
}

/** An app trading its refresh token for new access, as it does once the hour is up; `resource` for one that names the resource again. */
export function refresh(app: App, refreshToken: string, resource?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: app.clientId,
      ...(resource ? { resource } : {}),
    }),
  });
}

/** One MCP request, as an app's Streamable HTTP client sends it. */
export function mcp(token: string | null, method: string, params: unknown = {}, cookie?: string): Promise<Response> {
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
