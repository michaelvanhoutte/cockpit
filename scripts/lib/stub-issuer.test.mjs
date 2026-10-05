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
async function codeFor(email, { verifier = 'a-verifier-of-some-length', scope, name, offline } = {}) {
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
    ...(offline ? { access_type: 'offline' } : {}),
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

  // What connecting Gmail is handed and hands back ("Connect a Gmail account
  // to a workspace, and disconnect it", issue 724).
  it('grants a refresh token and the scopes asked only where offline access was asked, and takes it back', async () => {
    const grantFor = async (offline) =>
      (await spend(await codeFor('michael@example.com', { scope: 'openid email gmail.modify', offline }))).json();

    const offline = await grantFor(true);
    assert.match(offline.refresh_token, /^stub-refresh-/);
    assert.equal(offline.scope, 'openid email gmail.modify');
    assert.equal((await grantFor(false)).refresh_token, undefined);

    const revoked = await fetch(endpoints.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: offline.refresh_token }),
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await (await fetch(`${issuer.origin}/revoked`)).json(), [offline.refresh_token]);
  });

  // What checking a Gmail connection refreshes ("Bring in the conversations
  // already labelled Cockpit as tasks", issue 725).
  it('refreshes a sign-in it has not taken back, and refuses one it has', async () => {
    const refresh = (token) =>
      fetch(endpoints.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: 'c', client_secret: 's' }),
      });
    const granted = await (
      await spend(await codeFor('ada@example.com', { scope: 'openid email gmail.modify', offline: true }))
    ).json();

    const refreshed = await refresh(granted.refresh_token);
    assert.equal(refreshed.status, 200);
    assert.match((await refreshed.json()).access_token, /^stub-access-/);

    await fetch(endpoints.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: granted.refresh_token }),
    });
    assert.equal((await refresh(granted.refresh_token)).status, 400);
    assert.equal((await refresh('a-token-it-never-issued')).status, 400);
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

describe('the stub issuer stands in for a Claude Code routine the way Anthropic answers one', () => {
  const fire = (token) =>
    fetch(`${issuer.origin}/v1/claude_code/routines/trig_local/fire`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: `sent with ${token}` }),
    });

  it('starts a session, naming its link, and remembers what it was sent', async () => {
    const answer = await fire('any-token');

    assert.equal(answer.status, 200);
    const { claude_code_session_url: link } = await answer.json();
    assert.match(link, /\/claude-code\/session\/session_stub_/);
    assert.equal((await fetch(link)).status, 200);
    const fired = await (await fetch(`${issuer.origin}/claude-code/fired`)).json();
    assert.equal(fired.at(-1).text, 'sent with any-token');
  });

  it('refuses the token it is told to, and gives no link where it is told not to', async () => {
    assert.equal((await fire('refused')).status, 401);
    const noLink = await fire('no-link');
    assert.equal(noLink.status, 200);
    assert.equal((await noLink.json()).claude_code_session_url, undefined);
  });
});

describe('the stub issuer stands in for a Gmail mailbox the way Gmail answers', () => {
  async function accessTokenFor(email) {
    const granted = await (await spend(await codeFor(email, { scope: 'openid email gmail.modify', offline: true }))).json();
    return granted.access_token;
  }
  const read = (token, path) =>
    fetch(`${issuer.origin}/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` } });

  it('lists the conversations labelled Cockpit a page at a time, and reads each', async () => {
    const token = await accessTokenFor('michael@example.com');
    const { labels } = await (await read(token, 'labels')).json();
    const cockpit = labels.find((label) => label.name === 'Cockpit');

    const first = await (await read(token, `threads?labelIds=${cockpit.id}&maxResults=2`)).json();
    const second = await (
      await read(token, `threads?labelIds=${cockpit.id}&maxResults=2&pageToken=${first.nextPageToken}`)
    ).json();
    assert.equal(first.threads.length, 2);
    assert.equal(second.threads.length, 1);
    assert.equal(second.nextPageToken, undefined);

    const thread = await (await read(token, `threads/${first.threads[0].id}`)).json();
    assert.equal(
      thread.messages[0].payload.headers.find((header) => header.name === 'Subject').value,
      'Quarterly figures for the board',
    );
    assert.equal((await read(token, 'threads/no-such-thread')).status, 404);
  });

  it('has no label called Cockpit for an address starting no-label, and refuses a token it never issued', async () => {
    const { labels } = await (await read(await accessTokenFor('no-label@example.com'), 'labels')).json();
    assert.equal(labels.some((label) => label.name === 'Cockpit'), false);
    assert.equal((await read('not-a-stub-token', 'labels')).status, 401);
  });

  it('records a conversation labelled and a reply arriving as history, which moves the position on', async () => {
    const token = await accessTokenFor('history@example.com');
    const act = (what, query) =>
      fetch(`${issuer.origin}/gmail-stub/${what}?email=history%40example.com&${query}`, { method: 'POST' }).then((answer) => answer.json());
    const { historyId: before } = await (await read(token, 'profile')).json();

    const labelled = await act('label', 'subject=Hello');
    const reply = await act('reply', `thread=${labelled.thread}`);

    const { history, historyId } = await (await read(token, `history?startHistoryId=${before}`)).json();
    assert.equal(historyId, reply.historyId);
    assert.deepEqual(
      history.map((record) => Object.keys(record).filter((key) => key.startsWith('messages') || key.startsWith('labels'))),
      [['messages', 'labelsAdded'], ['messages', 'messagesAdded']],
    );
    const { threads } = await (await read(token, `threads?labelIds=Label_1001`)).json();
    assert.equal(threads.some((thread) => thread.id === labelled.thread), true);
    assert.equal(
      (await (await read(token, `history?startHistoryId=${reply.historyId}`)).json()).history,
      undefined,
    );
  });

  it('takes the label off, moves to the bin and labels again, each leaving the listing as Gmail would', async () => {
    const token = await accessTokenFor('closing@example.com');
    const act = (what, query) =>
      fetch(`${issuer.origin}/gmail-stub/${what}?email=closing%40example.com&${query}`, { method: 'POST' }).then((answer) => answer.json());
    const listed = async () => (await (await read(token, 'threads?labelIds=Label_1001')).json()).threads.map((thread) => thread.id);
    const { thread } = await act('label', 'subject=To%20close');
    const { historyId: before } = await (await read(token, 'profile')).json();

    await act('unlabel', `thread=${thread}`);
    assert.equal((await listed()).includes(thread), false);
    await act('label', `thread=${thread}`);
    assert.equal((await listed()).includes(thread), true);
    await act('trash', `thread=${thread}`);
    assert.equal((await listed()).includes(thread), false);
    await act('label', `thread=${thread}&quietly`);
    assert.equal((await listed()).includes(thread), true);

    const { history } = await (await read(token, `history?startHistoryId=${before}`)).json();
    assert.deepEqual(
      history.map((record) => [Object.keys(record).find((key) => key.startsWith('labels')), record[Object.keys(record).find((key) => key.startsWith('labels'))][0].labelIds]),
      [
        ['labelsRemoved', ['Label_1001']],
        ['labelsAdded', ['Label_1001']],
        ['labelsAdded', ['TRASH']],
      ],
    );
  });
});