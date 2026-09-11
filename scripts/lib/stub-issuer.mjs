import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

//
// An OpenID Connect issuer, for local development and the browser suite.
//
// **This is what keeps there being one way in.** Signing in is Google's answer
// to "who is this", and neither a worktree nor a test run can ask Google: a web
// OAuth client demands exact redirect URIs and every checkout here has ports of
// its own (lib/ports.mjs), quite apart from a browser suite that would need a
// real Google account to drive. The alternatives were a name picker kept alive
// behind a flag - a sign-in bypass compiled into the deployed application,
// defended by a variable being unset - or this: a second issuer, and one line
// of configuration saying which to believe (OIDC_ISSUER, apps/api/src/auth/
// issuer.ts).
//
// So the application runs the same code here as against Google: a real
// redirect, a real code exchange, a real RS256 signature checked against a
// published key, real state, nonce and PKCE. What differs is the consent
// screen, where Google shows an account chooser and this shows the people the
// seed put in the register, beside a box for anybody else and the name Google
// would give them.
//
// **Nothing here ships.** It is a script, started by `pnpm dev` and by the
// browser suite's own stack, and no deployed environment sets OIDC_ISSUER.
//

/**
 * The addresses to offer, read out of the seed rather than written down again.
 *
 * `seed.sql` is the file that decides who a fresh environment has, so a second
 * list here would be a thing to keep in step by hand - and the one already kept
 * in step by hand (apps/api/tests/integration/seed.ts) drifted within a day of
 * the column existing. If the shape of the seed ever changes, this offers
 * nobody, which is visible the moment anybody tries to sign in.
 */
export function accountsIn(seedPath) {
  // Comments first, or the file's own prose about placeholder addresses becomes
  // a person you can sign in as.
  const seed = readFileSync(seedPath, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const addresses = [...seed.matchAll(/'([^'\s]+@[^'\s]+)'/g)].map((match) => match[1]);
  return [...new Set(addresses)];
}

/**
 * Starts the issuer and answers its origin.
 *
 * The signing key is generated per run and never written down: it exists for as
 * long as the stack does, which is exactly as long as any token it signs is
 * worth anything.
 */
export async function startStubIssuer({ port, seedPath }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'stub-issuer';
  // Not `const`, because a port of 0 means "any free one" and which one that
  // was is only knowable once it is listening. Every read of it happens inside
  // a request, by which time it is settled.
  let issuer = `http://127.0.0.1:${port}`;
  const accounts = accountsIn(seedPath);
  /** Codes are single-use: spent once, gone, exactly as a real one is. */
  const issued = new Map();

  const server = createServer((request, response) => {
    const url = new URL(request.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }

    if (url.pathname === '/jwks') {
      // Exported off the key itself: `createPublicKey` takes key *material* or a
      // private key, and refuses a public KeyObject it has already made.
      const jwk = publicKey.export({ format: 'jwk' });
      return json(response, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    }

    if (url.pathname === '/authorize') return authorize(url, response);
    if (url.pathname === '/authorize/pick') return pick(url, response);
    if (url.pathname === '/token') return token(request, response);

    response.writeHead(404).end('no such endpoint');
  });

  /**
   * The consent screen: who do you want to be.
   *
   * A page rather than an immediate redirect, because that is what the real one
   * is - a browser walk that presses a button here presses a button there, and
   * a redirect that happened by itself would prove a flow nobody drives.
   */
  function authorize(url, response) {
    const ask = whatWasAsked(url);
    if (!ask.redirect_uri || !ask.state || !ask.code_challenge) {
      return response.writeHead(400).end('a sign-in has to say where to come back to');
    }

    const buttons = accounts
      .map(
        (email) =>
          `<li><a class="who" href="/authorize/pick?${new URLSearchParams({ ...ask, as: email })}">${escaped(email)}</a></li>`,
      )
      .join('');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      `<!doctype html><meta charset="utf-8"><title>Sign in</title>
       <style>body{font:16px system-ui;margin:3rem auto;max-width:28rem}
         li{list-style:none;margin:.5rem 0}
         a.who{display:block;padding:.6rem .8rem;border:1px solid #999;border-radius:.4rem;color:inherit;text-decoration:none}
         form{margin-top:1.5rem;display:flex;gap:.5rem}input{flex:1;padding:.5rem}</style>
       <h1>Choose an account</h1>
       <ul>${buttons}</ul>
       <form action="/authorize/pick"><input name="as" placeholder="somebody@example.com" required>
         <input name="name" placeholder="Their name at Google">
         ${Object.entries(ask)
           .map(([name, value]) => `<input type="hidden" name="${name}" value="${escaped(value)}">`)
           .join('')}
         <button>Continue</button></form>`,
    );
  }

  /** Picking somebody: a code, and back to where the sign-in came from. */
  function pick(url, response) {
    const ask = whatWasAsked(url);
    const code = randomUUID();
    issued.set(code, {
      email: ask.as,
      // Given only where `profile` was asked for, as Google gives it: a stub
      // handing over a name the application never asked for would pass here
      // what fails there.
      name: (ask.scope ?? '').split(' ').includes('profile') ? ask.name || undefined : undefined,
      nonce: ask.nonce,
      challenge: ask.code_challenge,
      clientId: ask.client_id,
      redirectUri: ask.redirect_uri,
    });
    const back = new URL(ask.redirect_uri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', ask.state);
    response.writeHead(302, { location: back.toString() }).end();
  }

  /**
   * Spending a code for an identity.
   *
   * The verifier is checked against the challenge, and the code is spent once -
   * both because a stub that skipped them would let a broken PKCE
   * implementation pass locally and fail against Google, which is the one
   * failure this whole arrangement exists to prevent.
   */
  function token(request, response) {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const form = new URLSearchParams(body);
      const held = issued.get(form.get('code') ?? '');
      issued.delete(form.get('code') ?? '');
      if (!held) return json(response, { error: 'invalid_grant' }, 400);
      if (!form.get('client_secret')) return json(response, { error: 'invalid_client' }, 401);
      if (challengeFor(form.get('code_verifier') ?? '') !== held.challenge) {
        return json(response, { error: 'invalid_grant' }, 400);
      }
      if (form.get('redirect_uri') !== held.redirectUri) {
        return json(response, { error: 'invalid_grant' }, 400);
      }
      json(response, { token_type: 'Bearer', id_token: identityToken(held) });
    });
  }

  function identityToken(held) {
    const now = Math.floor(Date.now() / 1000);
    return jwt(
      { alg: 'RS256', kid, typ: 'JWT' },
      {
        iss: issuer,
        aud: held.clientId,
        // Stable for an address, and unlike an address it never changes - which
        // is the distinction the application relies on.
        sub: `stub|${held.email}`,
        email: held.email,
        email_verified: true,
        ...(held.name ? { name: held.name } : {}),
        nonce: held.nonce,
        iat: now,
        exp: now + 300,
      },
    );
  }

  function jwt(header, payload) {
    const signing = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    return `${signing}.${base64url(sign('sha256', Buffer.from(signing), privateKey))}`;
  }

  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  issuer = `http://127.0.0.1:${server.address().port}`;
  return { origin: issuer, close: () => server.close() };
}

/**
 * What a sign-in asked for: the parameters of the flow and nothing else.
 *
 * **An allowlist rather than everything that arrived**, because everything that
 * arrived is a name *and* a value somebody else chose, and both end up in the
 * page below. Escaping the values and interpolating the names was the version
 * of this that shipped to review: a parameter *named* `x"><script>` closed the
 * attribute and put script on the page. Only these names can be written now, so
 * the question does not arise - and a stub nobody would attack is still a page
 * a browser renders, on a port every worktree runs.
 */
const OF_THE_FLOW = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'prompt',
  'as',
  'name',
];

function whatWasAsked(url) {
  return Object.fromEntries(
    OF_THE_FLOW.filter((name) => url.searchParams.has(name)).map((name) => [
      name,
      url.searchParams.get(name),
    ]),
  );
}

/** Text going into an attribute or a body, with what would end either taken out. */
function escaped(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function challengeFor(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}
