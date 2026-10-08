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

/** The directory a locally connected Microsoft account belongs to. */
const LOCAL_TENANT = 'cockpit-local-tenant';

/** What the Bot Framework calls itself, and what a channel call has to name. */
const CHANNEL_ISSUER = 'https://api.botframework.com';

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
  /** Every routine fire answered, newest last - what `/claude-code/fired` lists, for a walk to read back what was sent. */
  const fired = [];
  /** Every token handed back at `/revoke`, newest last. */
  const revoked = [];
  /** Every `threads.modify` Gmail was asked for, newest last - what `/gmail-stub/modified` lists. */
  const modifications = [];

  /**
   * Answers a routine fire the way Anthropic's API does: the error envelope
   * for a refusal, and `claude_code_session_url` for a session.
   */
  function fireRoutine(routineId, request, response) {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      let text = '';
      try {
        text = JSON.parse(body || '{}').text ?? '';
      } catch {
        // A body that is not JSON is sent nothing, as Anthropic's would be.
      }
      if (token === 'refused') {
        fired.push({ routineId, text, answered: 401 });
        return json(response, { type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, 401);
      }
      const sessionId = `session_stub_${randomUUID()}`;
      fired.push({ routineId, text, answered: 200 });
      if (token === 'no-link') return json(response, { type: 'routine_fire' });
      json(response, {
        type: 'routine_fire',
        claude_code_session_id: sessionId,
        claude_code_session_url: `${issuer}/claude-code/session/${sessionId}`,
      });
    });
  }

  /**
   * The stand-in mailboxes, kept for the life of the issuer so what is done to
   * one - a conversation labelled, a reply arriving - is still there when the
   * next check reads it ("Bring in a conversation within five minutes of
   * labelling it Cockpit", issue 726).
   */
  const mailboxes = new Map();
  function heldMailbox(email) {
    if (!mailboxes.has(email)) mailboxes.set(email, stubMailbox(email));
    return mailboxes.get(email);
  }

  /**
   * What a person does in Gmail, for a walk to do it from outside:
   * `POST /gmail-stub/label?email=&subject=&text=` labels a new conversation
   * Cockpit, and `POST /gmail-stub/reply?email=&thread=` adds a reply to one -
   * each leaving the history record Gmail would, and moving the mailbox's
   * position on. `POST /gmail-stub/unlabel?email=&thread=` takes the label
   * off one, `/gmail-stub/trash?email=&thread=` moves it to the bin, and
   * `/gmail-stub/label?email=&thread=` puts the label back ("Close a Gmail
   * task when its label comes off", issue 727). `POST
   * /gmail-stub/star?email=&subject=&text=` stars a new conversation, as
   * flagging it in Outlook does ("Connect Gmail by star, and bring in
   * conversations starred from then on", issue 822);
   * `/gmail-stub/unstar?email=&thread=` takes the star off one, and
   * `/gmail-stub/star?email=&thread=` puts it back ("Keep a starred Gmail task
   * in step with its star, both ways", issue 823).
   */
  function actInMailbox(action, url, response) {
    const email = url.searchParams.get('email') ?? '';
    const mailbox = heldMailbox(email);
    const cockpit = mailbox.labels.find((label) => label.name === 'Cockpit');
    const starring = action === 'star' || action === 'unstar';
    // Starring needs no label, as a mailbox followed by star needs none.
    if (!cockpit && !starring) return json(response, { error: 'that mailbox has no label called Cockpit' }, 409);
    mailbox.historyId += 1;
    const at = String(mailbox.historyId);
    const messageOf = (id, threadId, labelIds, subject, from, words) => ({
      id,
      threadId,
      labelIds,
      snippet: '',
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: subject },
          { name: 'From', value: from },
        ],
        body: { size: words.length, data: base64url(words) },
      },
    });
    const named = url.searchParams.get('thread');
    const removing = action === 'unlabel' || action === 'unstar';
    if (removing || action === 'trash' || ((action === 'label' || action === 'star') && named)) {
      const thread = mailbox.threads.find((one) => one.id === named);
      if (!thread) return json(response, { error: 'no such thread' }, 404);
      const moved = action === 'trash' ? 'TRASH' : starring ? 'STARRED' : cockpit.id;
      for (const message of thread.messages) {
        message.labelIds = removing
          ? message.labelIds.filter((label) => label !== moved)
          : [...new Set([...message.labelIds.filter((label) => !(action === 'label' && label === 'TRASH')), moved])];
      }
      // `quietly` leaves no history record, as a change the history missed -
      // which only the nightly read of the whole mailbox finds.
      if (!url.searchParams.has('quietly')) {
        const [first] = thread.messages;
        mailbox.history.push({
          id: at,
          messages: [{ id: first.id, threadId: thread.id }],
          [removing ? 'labelsRemoved' : 'labelsAdded']: [
            { message: { id: first.id, threadId: thread.id, labelIds: first.labelIds }, labelIds: [moved] },
          ],
        });
      }
      return json(response, { thread: thread.id, historyId: at });
    }
    if (action === 'label' || action === 'star') {
      const mark = action === 'star' ? 'STARRED' : cockpit.id;
      const id = `18f0a1b2c3d4e${at}`;
      const message = messageOf(
        id,
        id,
        ['INBOX', mark],
        url.searchParams.get('subject') ?? (action === 'star' ? 'Starred just now' : 'Labelled just now'),
        'Anna Peeters <anna@example.com>',
        url.searchParams.get('text') ?? (action === 'star' ? 'Starred a moment ago.' : 'Labelled Cockpit a moment ago.'),
      );
      mailbox.threads.push({ id, historyId: at, messages: [message] });
      mailbox.history.push({
        id: at,
        messages: [{ id, threadId: id }],
        labelsAdded: [{ message: { id, threadId: id, labelIds: message.labelIds }, labelIds: [mark] }],
      });
      return json(response, { thread: id, historyId: at });
    }
    const thread = mailbox.threads.find((one) => one.id === url.searchParams.get('thread'));
    if (!thread) return json(response, { error: 'no such thread' }, 404);
    const id = `reply-${at}`;
    const reply = messageOf(id, thread.id, ['INBOX', 'UNREAD'], 'Re:', 'pieter@example.com', 'A reply, arriving without the label.');
    thread.messages.push(reply);
    mailbox.history.push({
      id: at,
      messages: [{ id, threadId: thread.id }],
      messagesAdded: [{ message: { id, threadId: thread.id, labelIds: reply.labelIds } }],
    });
    json(response, { thread: thread.id, historyId: at });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
      });
    }

    // Handing a Gmail connection's sign-in back on disconnecting ("Connect a
    // Gmail account to a workspace, and disconnect it", issue 724): answered as
    // Google answers, and listed at `/revoked` for a walk to read back.
    if (url.pathname === '/revoke' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        revoked.push(new URLSearchParams(body).get('token') ?? '');
        response.writeHead(200).end();
      });
      return;
    }
    if (url.pathname === '/revoked') return json(response, revoked);

    if (url.pathname === '/jwks') {
      // Exported off the key itself: `createPublicKey` takes key *material* or a
      // private key, and refuses a public KeyObject it has already made.
      const jwk = publicKey.export({ format: 'jwk' });
      return json(response, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    }

    // The Bot Framework's half: the keys a saved Teams message is checked
    // against, and a way to mint the call itself ("Save a Teams message to
    // Cockpit", issue 486). Here rather than in a second script for the reason
    // Microsoft's sign-in is here: it is the same key, the same signing, and
    // one address to print.
    if (url.pathname === '/botframework/.well-known/openidconfiguration') {
      return json(response, {
        issuer: CHANNEL_ISSUER,
        jwks_uri: `${issuer}/botframework/keys`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url.pathname === '/botframework/keys') {
      const jwk = publicKey.export({ format: 'jwk' });
      return json(response, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    }
    // A channel token, for driving the ingress by hand: `?aud=<the bot's app
    // id>&serviceUrl=<the address the call claims to come from>`. Teams mints
    // this for itself; locally there is no Teams, so this stands in for the one
    // thing a person cannot produce.
    if (url.pathname === '/botframework/token') {
      const now = Math.floor(Date.now() / 1000);
      return json(response, {
        token: jwt(
          { alg: 'RS256', kid, typ: 'JWT' },
          {
            iss: CHANNEL_ISSUER,
            aud: url.searchParams.get('aud') ?? 'cockpit-local-bot',
            serviceurl: url.searchParams.get('serviceUrl') ?? 'https://smba.trafficmanager.net/emea/',
            iat: now,
            exp: now + 600,
          },
        ),
      });
    }

    // A stand-in Claude Code routine ("Drop an agent on an item to start a
    // Claude Code session on it", issue 571): the API reaches it instead of
    // Anthropic where `CLAUDE_CODE_ROUTINES_ORIGIN` names this issuer, so an
    // agent can be started locally without a real routine, and without a
    // browser walk starting real sessions. The token says how it answers:
    // `refused` a 401, `no-link` an acceptance with no session link, anything
    // else a session.
    const fire = url.pathname.match(/^\/v1\/claude_code\/routines\/([^/]+)\/fire$/);
    if (fire && request.method === 'POST') return fireRoutine(fire[1], request, response);
    if (url.pathname === '/claude-code/fired') return json(response, fired);
    if (url.pathname.startsWith('/claude-code/session/')) {
      return response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset="utf-8"><title>Claude Code session</title><h1>A stand-in Claude Code session</h1>');
    }

    if (url.pathname.startsWith('/gmail/v1/users/me/')) return gmail(url, request, response);
    const acting = url.pathname.match(/^\/gmail-stub\/(label|unlabel|trash|reply|star|unstar)$/);
    if (acting && request.method === 'POST') return actInMailbox(acting[1], url, response);
    // What a walk reads back of a conversation Cockpit changed (issue 728):
    // whether it is labelled Cockpit now, or starred (issue 823), and every
    // change Cockpit asked for.
    if (url.pathname === '/gmail-stub/thread') {
      const mailbox = heldMailbox(url.searchParams.get('email') ?? '');
      const cockpit = mailbox.labels.find((label) => label.name === 'Cockpit');
      const thread = mailbox.threads.find((one) => one.id === url.searchParams.get('thread'));
      if (!thread) return json(response, { error: 'no such thread' }, 404);
      return json(response, {
        thread: thread.id,
        labelled: thread.messages.some((message) => cockpit && message.labelIds.includes(cockpit.id)),
        starred: thread.messages.some((message) => message.labelIds.includes('STARRED')),
      });
    }
    if (url.pathname === '/gmail-stub/modified') return json(response, modifications);
    // Every call Gmail was asked of one mailbox, oldest first - so a walk can
    // wait for a check to have read the mailbox's position before acting.
    if (url.pathname === '/gmail-stub/asked') {
      return json(response, heldMailbox(url.searchParams.get('email') ?? '').asked);
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
      // What Google grants a Gmail connection (issue 724): a refresh token
      // only where offline access was asked for, and every scope asked
      // granted, as if nothing on the consent screen was unticked.
      scope: ask.scope ?? '',
      offline: ask.access_type === 'offline',
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
      if (form.get('grant_type') === 'refresh_token') return refresh(form, response);
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
      json(response, {
        token_type: 'Bearer',
        id_token: identityToken(held),
        ...(held.offline
          ? {
              access_token: tokenFor('access', held.email),
              expires_in: 3599,
              refresh_token: tokenFor('refresh', held.email),
              scope: held.scope,
            }
          : {}),
      });
    });
  }

  /**
   * Refreshing a Gmail connection's access token ("Bring in the conversations
   * already labelled Cockpit as tasks", issue 725): refused as Google refuses
   * a revoked one, and otherwise a new access token for the same mailbox.
   */
  function refresh(form, response) {
    const refreshToken = form.get('refresh_token') ?? '';
    const email = mailboxOf(refreshToken, 'refresh');
    if (!email || revoked.includes(refreshToken)) return json(response, { error: 'invalid_grant' }, 400);
    json(response, { access_token: tokenFor('access', email), expires_in: 3599, token_type: 'Bearer' });
  }

  /**
   * The stand-in mailbox at Gmail's own paths, read with an access token this
   * stub issued, so the token says whose it is.
   */
  function gmail(url, request, response) {
    const email = mailboxOf((request.headers.authorization ?? '').replace(/^Bearer /, ''), 'access');
    if (!email) return json(response, { error: { code: 401, message: 'Invalid Credentials' } }, 401);
    const path = url.pathname.slice('/gmail/v1/users/me/'.length);
    const mailbox = heldMailbox(email);
    mailbox.asked.push(path);
    if (path === 'labels') return json(response, { labels: mailbox.labels });
    if (path === 'profile') {
      return json(response, { emailAddress: email, messagesTotal: 3, threadsTotal: 3, historyId: String(mailbox.historyId) });
    }
    if (path === 'history') {
      const since = Number(url.searchParams.get('startHistoryId') ?? 0);
      const after = mailbox.history.filter((record) => Number(record.id) > since);
      const from = Number(url.searchParams.get('pageToken') ?? 0);
      const size = Number(url.searchParams.get('maxResults') ?? 100);
      const page = after.slice(from, from + size);
      return json(response, {
        ...(page.length > 0 ? { history: page } : {}),
        ...(from + size < after.length ? { nextPageToken: String(from + size) } : {}),
        historyId: String(mailbox.historyId),
      });
    }
    if (path === 'threads') {
      // Gmail leaves the bin out of a listing unless asked for it.
      const labelled = mailbox.threads.filter((thread) =>
        thread.messages.some(
          (message) => message.labelIds.includes(url.searchParams.get('labelIds')) && !message.labelIds.includes('TRASH'),
        ),
      );
      const from = Number(url.searchParams.get('pageToken') ?? 0);
      const size = Number(url.searchParams.get('maxResults') ?? 100);
      const page = labelled.slice(from, from + size);
      return json(response, {
        threads: page.map((thread) => ({ id: thread.id, snippet: '', historyId: String(mailbox.historyId) })),
        ...(from + size < labelled.length ? { nextPageToken: String(from + size) } : {}),
        resultSizeEstimate: labelled.length,
      });
    }
    const modified = mailbox.threads.find((one) => path === `threads/${one.id}/modify`);
    if (modified && request.method === 'POST') return modifyThread(mailbox, modified, request, response);
    const thread = mailbox.threads.find((one) => path === `threads/${one.id}`);
    if (thread) return json(response, thread);
    json(response, { error: { code: 404, message: 'Requested entity was not found.' } }, 404);
  }

  /**
   * `users.threads.modify` ("Take the Cockpit label off in Gmail when its task
   * is done in Cockpit", issue 728): the labels added to and taken off every
   * message of the conversation, leaving a history record for each message
   * whose labels actually changed - none where they were already so, as Gmail
   * records none.
   */
  function modifyThread(mailbox, thread, request, response) {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let change;
      try {
        change = JSON.parse(body || '{}');
      } catch {
        return json(response, { error: { code: 400, message: 'Invalid JSON payload received.' } }, 400);
      }
      const adding = change.addLabelIds ?? [];
      const removing = change.removeLabelIds ?? [];
      for (const message of thread.messages) {
        const before = message.labelIds;
        const after = [...new Set([...before, ...adding])].filter((label) => !removing.includes(label));
        const added = after.filter((label) => !before.includes(label));
        const removed = before.filter((label) => !after.includes(label));
        message.labelIds = after;
        if (added.length === 0 && removed.length === 0) continue;
        mailbox.historyId += 1;
        mailbox.history.push({
          id: String(mailbox.historyId),
          messages: [{ id: message.id, threadId: thread.id }],
          ...(added.length > 0
            ? { labelsAdded: [{ message: { id: message.id, threadId: thread.id, labelIds: after }, labelIds: added }] }
            : {}),
          ...(removed.length > 0
            ? { labelsRemoved: [{ message: { id: message.id, threadId: thread.id, labelIds: after }, labelIds: removed }] }
            : {}),
        });
      }
      modifications.push({ thread: thread.id, ...change });
      json(response, {
        id: thread.id,
        historyId: String(mailbox.historyId),
        messages: thread.messages.map((message) => ({ id: message.id, threadId: thread.id, labelIds: message.labelIds })),
      });
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
        // The directory and the person inside it, which Microsoft puts on a
        // token and Google does not. Signing in reads neither, and connecting
        // a Teams account keys on the pair (packages/connectors/teams/src/sign-in.ts) -
        // so without them a locally connected account would be keyed on
        // something a saved message can never name, and the one path this stub
        // exists to make drivable would not be.
        tid: LOCAL_TENANT,
        oid: `stub|${held.email}`,
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
  'access_type',
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

/**
 * A token naming the mailbox it is for, so it outlives the stub: `pnpm dev`
 * starts a new one every run, and a connection made under the last one has
 * to go on being checked.
 */
function tokenFor(kind, email) {
  return `stub-${kind}-${base64url(email)}-${randomUUID()}`;
}

/** The mailbox a token this stub issued is for, or null for one it did not. */
function mailboxOf(token, kind) {
  const match = new RegExp(`^stub-${kind}-([A-Za-z0-9_-]+)-[0-9a-f-]{36}$`).exec(token);
  return match ? Buffer.from(match[1], 'base64url').toString('utf8') : null;
}

/** The stand-in Cockpit label's id, as Gmail names a label somebody made. */
const COCKPIT_LABEL_ID = 'Label_1001';

/**
 * What every stand-in mailbox holds: three conversations labelled Cockpit,
 * shaped as Gmail's `threads.get` answers - one plain text, one HTML only,
 * and one with no subject whose labelled message is not its last. An address
 * starting `no-label` has no label called Cockpit at all, which is the row's
 * failing state.
 */
export function stubMailbox(email) {
  const labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    ...(email.startsWith('no-label') ? [] : [{ id: COCKPIT_LABEL_ID, name: 'Cockpit', type: 'user' }]),
  ];
  const labelled = ['INBOX', COCKPIT_LABEL_ID];
  const message = (id, threadId, at, labelIds, headers, part) => ({
    id,
    threadId,
    labelIds,
    snippet: '',
    internalDate: String(Date.parse(at)),
    payload: { mimeType: part.mimeType, headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: part.body, parts: part.parts },
  });
  const text = (mimeType, words) => ({ mimeType, body: { size: words.length, data: base64url(words) } });
  return {
    labels,
    // Gmail's position in the mailbox, and what changed at each one since.
    historyId: 1000,
    history: [],
    // Every path Gmail was asked for, oldest first (`/gmail-stub/asked`).
    asked: [],
    threads: [
      {
        id: '18f0a1b2c3d4e5f1',
        historyId: '1000',
        messages: [
          message(
            '18f0a1b2c3d4e5f1',
            '18f0a1b2c3d4e5f1',
            '2026-10-01T08:30:00Z',
            labelled,
            { Subject: 'Quarterly figures for the board', From: 'Anna Peeters <anna@example.com>' },
            text('text/plain', 'Can you send me the Q3 figures before Friday?\n\nThanks, Anna'),
          ),
        ],
      },
      {
        id: '18f0a1b2c3d4e5f2',
        historyId: '1000',
        messages: [
          message(
            '18f0a1b2c3d4e5f2',
            '18f0a1b2c3d4e5f2',
            '2026-10-02T12:00:00Z',
            labelled,
            { Subject: 'Lunch on Thursday?', From: 'pieter@example.com' },
            {
              mimeType: 'multipart/alternative',
              body: { size: 0 },
              parts: [text('text/html', '<div>Shall we have <b>lunch</b> on Thursday?</div><div>Pieter</div>')],
            },
          ),
        ],
      },
      {
        id: '18f0a1b2c3d4e5f3',
        historyId: '1000',
        messages: [
          message(
            '18f0a1b2c3d4e5f3',
            '18f0a1b2c3d4e5f3',
            '2026-10-03T09:00:00Z',
            labelled,
            { Subject: '', From: '"Lotte Janssens" <lotte@example.com>' },
            text('text/plain', 'The contract is signed - please file it.'),
          ),
          message(
            '18f0a1b2c3d4e5f4',
            '18f0a1b2c3d4e5f3',
            '2026-10-03T10:00:00Z',
            ['INBOX'],
            { Subject: 'Re:', From: 'michael@example.com' },
            text('text/plain', 'Thanks, will do.'),
          ),
        ],
      },
    ],
  };
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
