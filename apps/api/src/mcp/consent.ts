import { Hono, type Context } from 'hono';
import { AuthorizationError, CimdFetchError, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env.js';
import { visitorHeld } from '../auth/gate.js';
import { returnPathFrom } from '../auth/return-path.js';
import type { Visitor } from '../auth/register.js';
import { whoCanConsent, type GrantProps } from './grant.js';
import { asReachedAt, oauthHelpersFor } from './oauth.js';
import { AUTHORIZE_PATH } from './paths.js';

/**
 * The consent page: "Allow Claude to create items in your Cockpit?"
 * ("Connect Claude to Cockpit, and capture an item from it", issue 599).
 *
 * **The only place a grant is made**, and only by somebody signed in with
 * Google. In order, and each step before anything is shown:
 *
 * 1. The request is checked by the library - the client exists and the
 *    redirect address is one it registered. A request failing that is
 *    refused on this page and never sent anywhere, since an address the
 *    client never registered is exactly the one not to trust.
 * 2. Somebody not signed in is sent through Google sign-in and back here
 *    (`auth/return-path.ts`).
 * 3. The guest is refused, and told to sign in with Google: the guest account
 *    is shared by everybody who presses "Continue as guest" (`grant.ts`).
 * 4. Only then the page, whose form works once, for ten minutes, in this
 *    browser (the library's consent transaction).
 *
 * **Outside the sign-in gate and in front of the application**, routed by
 * `worker.ts`: the gate answers nobody with a `401`, and somebody arriving
 * here from an app has to be walked through signing in instead. The page reads
 * the sign-in itself, the way the gate does.
 *
 * **A page the Worker writes rather than one the SPA draws**, because the
 * library's consent transaction is a cookie and two headers on the response
 * that shows the form - and because nothing about this page is the app's.
 */
export const consent = new Hono<{ Bindings: Env }>();

consent.get(AUTHORIZE_PATH, async (c) => {
  const oauth = oauthHelpersFor(c.env);
  let request: AuthRequest;
  try {
    request = await oauth.parseAuthRequest(asReachedAt(c.req.raw, c.env));
  } catch (error) {
    return refused(c, error);
  }

  const visitor = await signedIn(c);
  if (!visitor) {
    const back = returnPathFrom(`${AUTHORIZE_PATH}${new URL(c.req.url).search}`);
    // An address too long to carry through signing in would come back as
    // `/`, leaving the app waiting on a page nobody returns to - so say so,
    // and the second attempt, signed in already, needs no carrying.
    if (!back) return signInFirst(c);
    return c.redirect(`/v1/sign-in/google?${new URLSearchParams({ return: back })}`, 302);
  }
  if (!(await whoCanConsent(c.env, visitor.userId))) return guestRefused(c);

  const details = await oauth.describeConsent(request);
  const transaction = await oauth.beginConsent(request);
  transaction.headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(
    page({
      title: `Allow ${details.clientName}?`,
      body: `
        <h1>Allow ${escape(details.clientName)} to create items in your Cockpit?</h1>
        <p>${escape(details.clientName)} will be able to capture notes into the Inbox of <strong>${escape(visitor.name)}</strong>'s Cockpit, and to see the names of your workspaces and types so it can say where each note goes. It cannot see your items, or change or delete anything.</p>
        <p class="faint">Access will be sent to <strong>${escape(details.redirectHost)}</strong>.${
          details.redirectIsLoopback
            ? ' That is an app on this computer: allow it only if you just started connecting it.'
            : ''
        } This app named itself; Cockpit has not checked the name.</p>
        <form method="post" action="${AUTHORIZE_PATH}">
          <input type="hidden" name="handle" value="${escape(transaction.handle)}">
          <input type="hidden" name="for" value="${escape(visitor.userId)}">
          <div class="actions">
            <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
            <button type="submit" name="decision" value="allow">Allow</button>
          </div>
        </form>`,
    }),
    { status: 200, headers: transaction.headers },
  );
});

consent.post(AUTHORIZE_PATH, async (c) => {
  const form = await c.req.parseBody();
  const handle = typeof form.handle === 'string' ? form.handle : '';
  // The form's own request, without its body (already read above): what the
  // library reads off it is the address and the consent cookie.
  const asked = asReachedAt(new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers }), c.env);
  const oauth = oauthHelpersFor(c.env);

  try {
    // **Deny first, and with no sign-in needed**: the handle and the cookie
    // binding it to this browser are what make a press genuine, and refusing
    // an app is never something to stop somebody doing. A sign-in that ran out
    // while the page stood open still tells the app it was refused.
    if (form.decision !== 'allow') {
      const denied = await oauth.denyConsent(asked, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Asked again rather than trusted from the page: a sign-out, or another
    // sign-in in another tab, between showing the form and pressing Allow.
    // **And it must be the person the page was shown to**, which the form
    // carries: a different person signed in since would otherwise hand the app
    // their own account from a page that named somebody else's.
    const visitor = await signedIn(c);
    if (!visitor) return cannotConnect(c);
    if (form.for !== visitor.userId) return somebodyElse(c);
    const consenting = await whoCanConsent(c.env, visitor.userId);
    if (!consenting) return guestRefused(c);

    const approved = await oauth.approveConsent(asked, handle);
    const details = await oauth.describeConsent(approved.request);
    const props: GrantProps = {
      userId: visitor.userId,
      subject: consenting.subject,
      clientName: details.clientName,
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: visitor.userId,
      metadata: { clientName: details.clientName },
      scope: approved.request.scope,
      props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return refused(c, error);
  }
});

/** Who is signed in on this browser, or `null` - read the way the gate reads it. */
async function signedIn(c: Context<{ Bindings: Env }>): Promise<Visitor | null> {
  return (await visitorHeld(c, new Date()))?.visitor ?? null;
}

/**
 * What a request the library would not accept is answered with.
 *
 * Sent back to the client only where the library says that is safe - the
 * client and its exact redirect address are both known good - and shown here
 * otherwise. Anything that is not the library's own refusal is a fault rather
 * than a bad request, and is thrown on to answer `500`.
 */
function refused(c: Context<{ Bindings: Env }>, error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return c.redirect(error.redirectTo, 302);
  if (!(error instanceof AuthorizationError || error instanceof CimdFetchError)) throw error;
  console.warn(
    JSON.stringify({
      level: 'warn',
      message: 'an app could not be connected',
      cause: error instanceof AuthorizationError ? error.description : error.message,
    }),
  );
  return cannotConnect(c);
}

/** Somebody other than the person the page was shown to pressed Allow. */
function somebodyElse(c: Context<{ Bindings: Env }>): Response {
  return c.html(
    page({
      title: 'Signed in as somebody else',
      body: `
        <h1>Signed in as somebody else</h1>
        <p>Somebody else signed in to Cockpit on this browser after this page was shown, so it has not connected the app. Start connecting again from the app.</p>`,
    }),
    409,
  );
}

/** Somebody not signed in, from an app whose address is too long to come back to after signing in. */
function signInFirst(c: Context<{ Bindings: Env }>): Response {
  return c.html(
    page({
      title: 'Sign in to Cockpit first',
      body: `
        <h1>Sign in to Cockpit first</h1>
        <p>This app's request is too long to bring back here after signing in. Sign in to Cockpit in this browser, then start connecting again from the app.</p>
        <div class="actions"><a class="button" href="/v1/sign-in/google">Sign in with Google</a></div>`,
    }),
    200,
  );
}

/** The one page a request that cannot go anywhere is shown. */
function cannotConnect(c: Context<{ Bindings: Env }>): Response {
  return c.html(
    page({
      title: 'This app cannot be connected',
      body: `
        <h1>This app cannot be connected</h1>
        <p>The request it opened this page with is not one Cockpit can accept, or this page has already been used. Start connecting again from the app.</p>`,
    }),
    400,
  );
}

/** Somebody signed in as the guest, or without a Google identity this Cockpit can hold a grant for. */
function guestRefused(c: Context<{ Bindings: Env }>): Response {
  const back = returnPathFrom(`${AUTHORIZE_PATH}${new URL(c.req.url).search}`);
  const signIn = back ? `/v1/sign-in/google?${new URLSearchParams({ return: back })}` : '/v1/sign-in/google';
  return c.html(
    page({
      title: 'Sign in with Google to connect an app',
      body: `
        <h1>Sign in with Google to connect an app</h1>
        <p>The guest account is shared by everybody who uses it, so no app can be given access to it.</p>
        ${
          c.req.method === 'GET'
            ? `<div class="actions"><a class="button" href="${escape(signIn)}">Sign in with Google</a></div>`
            : ''
        }`,
    }),
    403,
  );
}

/** Everything the client chose - its name above all - is escaped before it reaches the page. */
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page's frame, in the app's own palette (docs/design-system.md): the
 * page's warm grey, ink, and the default theme's violet for the one action.
 * Nothing is loaded from anywhere - the page has to render for somebody whose
 * app shell is not cached and who is midway through connecting something.
 */
function page({ title, body }: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} - Cockpit</title>
<style>
  body { margin: 0; background: #f3f3f1; color: #23242a; font: 15px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 32rem; margin: 12vh auto; padding: 2rem; background: #fff; border-radius: 14px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.3rem; line-height: 1.3; margin: 0 0 1rem; color: #594e91; }
  p { margin: 0 0 1rem; }
  .faint { color: #5f6068; font-size: .9rem; }
  .actions { display: flex; gap: .75rem; justify-content: flex-end; margin-top: 1.5rem; }
  button, .button { font: inherit; padding: .5rem 1.1rem; border-radius: 8px; border: 1px solid #594e91; background: #6f62b5; color: #fff; cursor: pointer; text-decoration: none; }
  button.secondary { background: transparent; color: #594e91; }
  @media (max-width: 30rem) { main { margin: 0; border-radius: 0; min-height: 100vh; box-sizing: border-box; } }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
