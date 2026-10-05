import { vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { modifyAnswer } from '../gmail-payloads.js';

/**
 * A Google that can be reached from inside a test.
 *
 * Signing in is a conversation with an issuer, and an issuer is horizontal -
 * another service, over the network - which L2 may not touch
 * (docs/testing-strategy.md, "Test level definitions and dependency
 * restrictions"). So the issuer is faked at the network boundary and nothing
 * else is: the application does its own redirect, its own code exchange and its
 * own signature check against a key this file publishes, exactly as it does
 * against Google.
 *
 * **Faked by replacing `fetch`**, which reaches the Worker because the pool
 * runs it in the same isolate as the test - the one thing that makes this
 * possible, and the reason it is written here once rather than per file.
 * (`cloudflare:test` exports no mock agent in this version.) Requests to
 * anywhere but the issuer are refused rather than let out, so a test that
 * starts talking to the real internet says so.
 *
 * Local development and the browser suite do the same thing with a real second
 * issuer instead (scripts/lib/stub-issuer.mjs), which is what keeps there being
 * one sign-in path everywhere rather than a bypass in the application.
 */

export const ISSUER = 'https://issuer.test';
export const CLIENT_ID = 'cockpit-test';

export interface Claims {
  email: string;
  nonce: string;
  subject?: string;
  emailVerified?: boolean;
  /** What Google calls them, which it gives for the `profile` scope. */
  name?: string;
  /**
   * The directory and the person inside it, which Microsoft puts on a token
   * and Google does not - what a connected Teams account is keyed on
   * (src/connectors/teams.ts), and so what an inbound saved message has to
   * name to find it ("Save a Teams message to Cockpit", issue 486).
   */
  tenant?: string;
  object?: string;
}

let keys: CryptoKeyPair | null = null;

/**
 * What the issuer hands back when each code is spent, or its refusal.
 *
 * Keyed by code rather than one answer for whichever comes next, so two
 * sign-ins in flight at once each get their own - which is what a case about
 * two first sign-ins racing needs.
 */
const answers = new Map<string, { claims: Claims; grant: Grant } | 'refuses'>();

/**
 * What the issuer hands over beside the identity, the way Google does for a
 * Gmail connection asked for offline access ("Connect a Gmail account to a
 * workspace, and disconnect it", issue 724): field names as Google spells
 * them, put into the answer as they are.
 */
export interface Grant {
  refresh_token?: string;
  access_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Every token handed back to be revoked, oldest first. */
export const revoked: string[] = [];

/** How the issuer answers a revoke: as Google does, with a refusal, or never. */
let revoking: 'answers' | 'refuses' | 'times out' = 'answers';

/**
 * Exchanges held back until a number of them have arrived, then answered at
 * once - so the sign-ins behind them reach the register at the same instant.
 *
 * **Without it two sign-ins "at once" are not at once.** One finishes writing
 * before the other has looked, and a case about them racing passes against
 * code with no answer to the race at all - which is what the first version of
 * that case did.
 *
 * **Answered by the test, never by the last exchange to arrive, and arrival
 * is a count the test polls rather than a promise.** The runtime wakes a
 * request for a promise another request resolved only once that one is done.
 * Opened from inside the second sign-in, the first one's answer waited for the
 * second to finish altogether, so the two still ran one after the other; and a
 * promise telling the test they had arrived never reached it, because the
 * sign-in that settled it was waiting on the test.
 */
let gate: { expected: number; count: number; opened: Promise<void> } | null = null;

async function signingKeys(): Promise<CryptoKeyPair> {
  keys ??= await generateKeyPair('RS256', { extractable: true });
  return keys;
}

/**
 * Puts the issuer on the network: where it answers, and what it signs with.
 *
 * Stubs every time rather than once, because a case elsewhere that calls
 * `vi.unstubAllGlobals()` would otherwise leave a later sign-in reaching for
 * the real internet with nothing here noticing it had been undone.
 */
export async function issuerIsReachable(): Promise<void> {
  // A hold a failed case left armed would stall every exchange after it.
  gate = null;
  revoking = 'answers';
  revoked.length = 0;
  const { publicKey } = await signingKeys();
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig' }] };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === GMAIL_API) return gmailAnswer(url, init);
    if (url.origin !== ISSUER) {
      throw new Error(`nothing in a test may reach ${url.origin}`);
    }

    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        revocation_endpoint: `${ISSUER}/revoke`,
      });
    }
    if (url.pathname === '/jwks') return Response.json(jwks);
    if (url.pathname === '/revoke') {
      revoked.push(new URLSearchParams(init?.body as URLSearchParams).get('token') ?? '');
      // What `AbortSignal.timeout` rejects with, without waiting it out.
      if (revoking === 'times out') throw new DOMException('The operation timed out.', 'TimeoutError');
      return revoking === 'refuses'
        ? Response.json({ error: 'invalid_token' }, { status: 400 })
        : new Response(null, { status: 200 });
    }
    if (url.pathname === '/token') {
      if (gate) {
        const waiting = gate;
        waiting.count += 1;
        await waiting.opened;
      }
      const form = new URLSearchParams(init?.body as URLSearchParams);
      if (form.get('grant_type') === 'refresh_token') return refreshAnswer(form);
      const code = form.get('code') ?? '';
      const asked = answers.get(code);
      // Spent once, as a real code is: what a second exchange of the same code
      // gets is the refusal, not another identity.
      answers.delete(code);
      if (!asked || asked === 'refuses') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ token_type: 'Bearer', ...asked.grant, id_token: await identityToken(asked.claims) });
    }
    throw new Error(`the issuer has no ${url.pathname}`);
  });
}

/**
 * Who the issuer will say somebody is, when the code they came back with is
 * spent - and what else it hands over beside that, where a case asks.
 */
export function issuerWillIdentify(claims: Claims, code = 'a-code', grant: Grant = {}): void {
  answers.set(code, { claims, grant });
}

/** The issuer refusing every revoke from now on, or never answering one. */
export function issuerRevokes(how: 'refuses' | 'times out'): void {
  revoking = how;
}

/** The issuer refusing to exchange a code, which is what a spent one gets. */
export function issuerWillRefuseTheExchange(code = 'a-code'): void {
  answers.set(code, 'refuses');
}

/**
 * Holds every exchange until `answer` lets them all through at once, once
 * `allArrived` says the expected number are waiting.
 */
export function issuerAnswersTogether(expected: number): {
  allArrived: () => boolean;
  answer: () => void;
} {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const waiting = { expected, count: 0, opened };
  gate = waiting;
  return {
    allArrived: () => waiting.count >= waiting.expected,
    answer: () => {
      gate = null;
      open();
    },
  };
}

/** Puts the issuer back out of reach, and forgets what it was going to say. */
export function issuerIsForgotten(): void {
  vi.unstubAllGlobals();
  gmailIsEmpty();
  answers.clear();
  gate = null;
  revoking = 'answers';
  revoked.length = 0;
}

export async function identityToken({
  email,
  nonce,
  subject = `google|${email}`,
  emailVerified = true,
  name,
  tenant,
  object,
}: Claims): Promise<string> {
  const { privateKey } = await signingKeys();
  return new SignJWT({
    nonce,
    email,
    email_verified: emailVerified,
    ...(name ? { name } : {}),
    ...(tenant ? { tid: tenant } : {}),
    ...(object ? { oid: object } : {}),
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/**
 * Gmail's API, on the same faked network ("Bring in the conversations already
 * labelled Cockpit as tasks", issue 725): one mailbox, answering the calls the
 * connector reads in the shapes Gmail answers them (../gmail-payloads.ts), and
 * Google's token endpoint refreshing an access token beside it.
 */
export const GMAIL_API = 'https://gmail.googleapis.com';

interface Mailbox {
  labels: unknown;
  historyId: string;
  /** Every conversation's `threads.get` answer, in the order `threads.list` lists them. */
  threads: { id: string; labelled: boolean; answer: unknown }[];
  /** What changed, as `users.history.list` records it (../gmail-payloads.ts `historyRecord`), oldest first; each record's id is its position. */
  history: { id: string }[];
  /** Whether Gmail has forgotten the positions it was asked from - it keeps them for about a week. */
  historyLapsed: boolean;
}

let mailbox: Mailbox = { labels: { labels: [] }, historyId: '1', threads: [], history: [], historyLapsed: false };

/** Every call Gmail was asked, as its path and query below `users/me/`, oldest first. */
export const gmailCalls: string[] = [];

/** Every change to a conversation's labels Gmail was asked for (`users.threads.modify`), oldest first. */
export const gmailModifies: { threadId: string; addLabelIds?: string[]; removeLabelIds?: string[] }[] = [];

/** A conversation as `threads.get` answers it, with these labels added to and taken off every message, as `threads.modify` does. */
function labelsChanged(answer: unknown, change: { addLabelIds?: string[]; removeLabelIds?: string[] }): unknown {
  const thread = answer as { messages?: { labelIds?: string[] }[] };
  return {
    ...thread,
    messages: (thread.messages ?? []).map((message) => ({
      ...message,
      labelIds: [
        ...new Set([...(message.labelIds ?? []), ...(change.addLabelIds ?? [])]),
      ].filter((label) => !(change.removeLabelIds ?? []).includes(label)),
    })),
  };
}

/** Every refresh Google was asked for, oldest first, by the refresh token it named. */
export const refreshes: string[] = [];

/** How Google answers a refresh: as it does, refusing the sign-in, or not answering usefully. */
let refreshing: 'answers' | 'refuses' | 'fails' = 'answers';

/** Gmail answering one kind of call with a status, once or every time, in place of its answer. */
let gmailFailing: { when: (call: string) => boolean; status: number; once: boolean; applied: boolean } | null = null;

/** Something the person does while Gmail or Google is being asked one call, before it is answered. */
let meanwhile: { when: (call: string) => boolean; action: () => Promise<void> } | null = null;

/** Forgets the mailbox and everything Gmail and Google were asked - each case starts from nothing. */
export function gmailIsEmpty(): void {
  mailbox = { labels: { labels: [] }, historyId: '1', threads: [], history: [], historyLapsed: false };
  gmailCalls.length = 0;
  gmailModifies.length = 0;
  refreshes.length = 0;
  refreshing = 'answers';
  gmailFailing = null;
  meanwhile = null;
}

/**
 * Runs `action` once, while the first call matching `when` waits for its
 * answer - a Gmail call as `gmailCalls` names it, or `refresh` for Google
 * refreshing a sign-in - so a case can act while a check is part-way through.
 */
export function whileGmailIsAsked(when: (call: string) => boolean, action: () => Promise<void>): void {
  meanwhile = { when, action };
}

async function actMeanwhile(call: string): Promise<void> {
  if (!meanwhile?.when(call)) return;
  const { action } = meanwhile;
  meanwhile = null;
  await action();
}

/** What the mailbox holds: its labels, and its conversations with whether each carries the label. */
export function gmailHolds(held: Partial<Mailbox>): void {
  mailbox = { ...mailbox, ...held };
}

/**
 * Gmail answering calls matching `when` with `status` instead - once, or until
 * told otherwise; and where `applied`, having done what was asked all the
 * same, as a change whose answer was lost on its way back.
 */
export function gmailAnswersWith(
  status: number,
  when: (call: string) => boolean,
  { once = true, applied = false } = {},
): void {
  gmailFailing = { when, status, once, applied };
}

/** Gmail answering every call as it does again. */
export function gmailAnswersAgain(): void {
  gmailFailing = null;
}

/** Google answering every refresh from now on by refusing the sign-in, or with a 503. */
export function googleRefreshes(how: 'answers' | 'refuses' | 'fails'): void {
  refreshing = how;
}

async function refreshAnswer(form: URLSearchParams): Promise<Response> {
  await actMeanwhile('refresh');
  const refreshToken = form.get('refresh_token') ?? '';
  refreshes.push(refreshToken);
  if (refreshing === 'refuses') return Response.json({ error: 'invalid_grant' }, { status: 400 });
  if (refreshing === 'fails') return Response.json({ error: 'backend_error' }, { status: 503 });
  return Response.json({
    access_token: `refreshed-${refreshes.length}-for-${refreshToken}`,
    expires_in: 3599,
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    token_type: 'Bearer',
  });
}

async function gmailAnswer(url: URL, init?: RequestInit): Promise<Response> {
  const call = `${url.pathname.replace(/^\/gmail\/v1\/users\/me\//, '')}${url.search}`;
  gmailCalls.push(call);
  await actMeanwhile(call);
  const token = new Headers(init?.headers).get('authorization') ?? '';
  if (!token.startsWith('Bearer ') || token.length <= 'Bearer '.length) {
    return Response.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 });
  }
  if (gmailFailing?.when(call)) {
    const { status, applied } = gmailFailing;
    if (gmailFailing.once) gmailFailing = null;
    // Done at Gmail, and only the answer lost on its way back.
    if (applied) await answered(url, init);
    return Response.json({ error: { code: status, message: 'Gmail did not answer this time' } }, { status });
  }
  return answered(url, init);
}

async function answered(url: URL, init?: RequestInit): Promise<Response> {
  const path = url.pathname.replace(/^\/gmail\/v1\/users\/me\//, '');
  if (path === 'labels') return Response.json(mailbox.labels);
  if (path === 'profile') {
    return Response.json({ emailAddress: 'anna@example.com', messagesTotal: 10, threadsTotal: 10, historyId: mailbox.historyId });
  }
  if (path === 'history') {
    if (mailbox.historyLapsed) return Response.json({ error: { code: 404, message: 'Requested entity was not found.' } }, { status: 404 });
    const since = BigInt(url.searchParams.get('startHistoryId') ?? 0);
    const after = mailbox.history.filter((record) => BigInt(record.id) > since);
    const from = Number(url.searchParams.get('pageToken') ?? 0);
    const size = Number(url.searchParams.get('maxResults') ?? 100);
    const page = after.slice(from, from + size);
    return Response.json({
      ...(page.length > 0 ? { history: page } : {}),
      ...(from + size < after.length ? { nextPageToken: String(from + size) } : {}),
      historyId: mailbox.historyId,
    });
  }
  if (path === 'threads') {
    const labelled = mailbox.threads.filter((thread) => thread.labelled);
    const from = Number(url.searchParams.get('pageToken') ?? 0);
    const size = Number(url.searchParams.get('maxResults') ?? 100);
    const page = labelled.slice(from, from + size);
    return Response.json({
      threads: page.map((thread) => ({ id: thread.id, snippet: '', historyId: mailbox.historyId })),
      ...(from + size < labelled.length ? { nextPageToken: String(from + size) } : {}),
      resultSizeEstimate: labelled.length,
    });
  }
  const modified = mailbox.threads.find((one) => path === `threads/${one.id}/modify`);
  if (modified && init?.method === 'POST') {
    const change = JSON.parse(String(init.body)) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    gmailModifies.push({ threadId: modified.id, ...change });
    modified.answer = labelsChanged(modified.answer, change);
    modified.labelled = (change.addLabelIds ?? []).length > 0 ? true : (change.removeLabelIds ?? []).length > 0 ? false : modified.labelled;
    return Response.json(modifyAnswer(modified.answer));
  }
  const thread = mailbox.threads.find((one) => path === `threads/${one.id}`);
  if (thread) return Response.json(thread.answer);
  return Response.json({ error: { code: 404, message: 'Requested entity was not found.' } }, { status: 404 });
}