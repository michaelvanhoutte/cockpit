import { vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

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
}

let keys: CryptoKeyPair | null = null;

/**
 * What the issuer hands back when each code is spent, or its refusal.
 *
 * Keyed by code rather than one answer for whichever comes next, so two
 * sign-ins in flight at once each get their own - which is what a case about
 * two first sign-ins racing needs.
 */
const answers = new Map<string, Claims | 'refuses'>();

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
  const { publicKey } = await signingKeys();
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig' }] };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== ISSUER) {
      throw new Error(`nothing in a test may reach ${url.origin}`);
    }

    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url.pathname === '/jwks') return Response.json(jwks);
    if (url.pathname === '/token') {
      if (gate) {
        const waiting = gate;
        waiting.count += 1;
        await waiting.opened;
      }
      const code = new URLSearchParams(init?.body as URLSearchParams).get('code') ?? '';
      const asked = answers.get(code);
      // Spent once, as a real code is: what a second exchange of the same code
      // gets is the refusal, not another identity.
      answers.delete(code);
      if (!asked || asked === 'refuses') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ token_type: 'Bearer', id_token: await identityToken(asked) });
    }
    throw new Error(`the issuer has no ${url.pathname}`);
  });
}

/** Who the issuer will say somebody is, when the code they came back with is spent. */
export function issuerWillIdentify(claims: Claims, code = 'a-code'): void {
  answers.set(code, claims);
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
  answers.clear();
  gate = null;
}

export async function identityToken({
  email,
  nonce,
  subject = `google|${email}`,
  emailVerified = true,
  name,
}: Claims): Promise<string> {
  const { privateKey } = await signingKeys();
  return new SignJWT({ nonce, email, email_verified: emailVerified, ...(name ? { name } : {}) })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
