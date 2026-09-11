import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubIssuer } from './stub-issuer.mjs';

//
// Script tier: the stub issuer is what local development and the browser suite
// sign in against, so a fault in it looks exactly like a fault in the
// application - and the browser suite would report it as one, from behind a
// redirect, with a screenshot of a logon page.
//
// What is worth pinning is the part a real issuer would refuse: the checks. A
// stub that handed out an identity for any code, any verifier, any second
// attempt would let a broken PKCE or replay defence pass here and fail against
// Google, which is the single failure this whole arrangement exists to prevent.
//

const seedPath = join(fileURLToPath(new URL('../../', import.meta.url)), 'apps/api/seed.sql');
const REDIRECT = 'http://localhost:1234/v1/sign-in/google/callback';

let issuer;
let endpoints;

before(async () => {
  issuer = await startStubIssuer({ port: 0, seedPath });
  endpoints = await (await fetch(`${issuer.origin}/.well-known/openid-configuration`)).json();
});

after(() => issuer.close());

/** Walks up to the point where a code has been issued, as a browser does. */
async function codeFor(email, { verifier = 'a-verifier-of-some-length', scope, name } = {}) {
  const ask = new URLSearchParams({
    client_id: 'cockpit-test',
    redirect_uri: REDIRECT,
    state: 'the-state',
    nonce: 'the-nonce',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    as: email,
    ...(scope ? { scope } : {}),
    ...(name ? { name } : {}),
  });
  const picked = await fetch(`${issuer.origin}/authorize/pick?${ask}`, { redirect: 'manual' });
  return new URL(picked.headers.get('location')).searchParams.get('code');
}

function spend(code, { verifier = 'a-verifier-of-some-length', secret = 'a-secret' } = {}) {
  return fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: 'cockpit-test',
      client_secret: secret,
    }),
  });
}

describe('the stub issuer signs people in the way Google does', () => {
  it('offers the people the seed put in the register', async () => {
    const page = await (
      await fetch(
        `${issuer.origin}/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=c`,
      )
    ).text();
    assert.match(page, /michael@example\.com/);
    assert.match(page, /ada@example\.com/);
  });

  it('hands back an identity signed with the key it publishes', async () => {
    const spent = await spend(await codeFor('michael@example.com'));
    const { id_token: token } = await spent.json();
    const [header, payload, signature] = token.split('.');

    const { keys } = await (await fetch(endpoints.jwks_uri)).json();
    const verifies = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url'));

    assert.equal(verifies, true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.deepEqual(
      { iss: claims.iss, aud: claims.aud, email: claims.email, verified: claims.email_verified },
      {
        iss: issuer.origin,
        aud: 'cockpit-test',
        email: 'michael@example.com',
        verified: true,
      },
    );
    assert.equal(claims.nonce, 'the-nonce');
  });

  it('names somebody the same way every time, whatever their address becomes', async () => {
    const first = await (await spend(await codeFor('ada@example.com'))).json();
    const again = await (await spend(await codeFor('ada@example.com'))).json();
    const subject = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
    assert.equal(subject(first.id_token), subject(again.id_token));
  });

  /**
   * Google gives a name only for the `profile` scope, so the stub does too: one
   * handing over a name the application never asked for would let a missing
   * scope pass here and fail there.
   */
  it('gives the name typed for somebody only where their profile was asked for', async () => {
    const claimsFor = async (scope) => {
      const code = await codeFor('rita@example.com', { scope, name: 'Rita Recruiter' });
      const { id_token: token } = await (await spend(code)).json();
      return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    };

    assert.equal((await claimsFor('openid email profile')).name, 'Rita Recruiter');
    assert.equal((await claimsFor('openid email')).name, undefined);
  });

  it('refuses a code spent with the wrong verifier', async () => {
    const spent = await spend(await codeFor('michael@example.com'), { verifier: 'not-the-one' });
    assert.equal(spent.status, 400);
  });

  it('refuses a code spent twice', async () => {
    const code = await codeFor('michael@example.com');
    assert.equal((await spend(code)).status, 200);
    assert.equal((await spend(code)).status, 400);
  });

  it('refuses an exchange with no client secret', async () => {
    const spent = await spend(await codeFor('michael@example.com'), { secret: '' });
    assert.equal(spent.status, 401);
  });

  it('refuses a sign-in that says nowhere to come back to', async () => {
    const asked = await fetch(`${issuer.origin}/authorize?state=s`);
    assert.equal(asked.status, 400);
  });

  /**
   * The page is rendered from a query string anybody can write, so what it
   * writes back has to be the flow's own parameters and nothing else. Both
   * halves have been wrong here: an unescaped value, and then a parameter whose
   * *name* closed the attribute it was written into.
   */
  it('writes nothing into the page that a sign-in did not ask for', async () => {
    const mischief = new URLSearchParams({
      redirect_uri: REDIRECT,
      state: 's',
      code_challenge: 'c',
      'x"><script>alert(1)</script': 'anything',
      nonce: '"><script>alert(2)</script>',
    });

    const page = await (await fetch(`${issuer.origin}/authorize?${mischief}`)).text();

    // Nothing got out of an attribute and became markup...
    assert.equal(/<script/i.test(page), false);
    // ...and the parameter that was not the flow's own is not on the page at
    // all, which is the half escaping alone would not give.
    assert.deepEqual(
      [...page.matchAll(/<input[^>]*name="([^"]*)"/g)].map((match) => match[1]).sort(),
      // `as` and `name` are the page's own boxes for anybody the seed does not
      // hold; the rest are the flow's, carried through.
      ['as', 'code_challenge', 'name', 'nonce', 'redirect_uri', 'state'],
    );
  });
});
