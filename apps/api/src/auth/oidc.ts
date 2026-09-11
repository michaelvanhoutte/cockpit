import { jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * The OpenID Connect code flow, as much of it as is ours: where to send the
 * browser, and what to believe about what comes back.
 *
 * Everything here is pure but for the randomness and the signature check, both
 * handed in, which is what makes every branch below provable at L1
 * (tests/unit/auth/oidc.test.ts). That matters more here than anywhere else in
 * the application: this is the code that decides who you are, and
 * docs/architecture.md ("App login: hand-rolled Google OIDC + own sessions")
 * asks for exactly this - state, nonce, CSRF and session fixation proved
 * exhaustively, in a project we maintain rather than in a framework we do not.
 *
 * **What it deliberately does not do is trust anything the browser carried.**
 * The reply from the issuer arrives through the person signing in, so every
 * field in it is theirs to change: the check is that it matches the attempt
 * this application started, and that the identity in it was signed by the
 * issuer for this application, recently, answering the question we asked.
 */

/**
 * Everything Cockpit asks Google for. `openid` is what makes this a sign-in
 * rather than an API grant, `email` is what the register is keyed on, and
 * `profile` is where the name comes from for somebody who signs in without
 * having been added first ("Sign in with any Google account, so a recruiter
 * doesn't need to be added first", issue 343) - nobody typed one in for them.
 *
 * Nothing here is a sensitive scope, which is what keeps a verification review
 * from standing between this and a working sign-in. Anything beyond these three
 * would want that sentence re-checked.
 */
export const SCOPES = 'openid email profile';

/** Where an issuer answers, as its own discovery document declares. */
export interface IssuerEndpoints {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

/**
 * What the browser is sent away with, and what has to come back for the reply
 * to be believed.
 *
 * All three are kept where only the browser that started the sign-in can carry
 * them back: `state` proves the reply belongs to this attempt, `nonce` proves
 * the identity was minted for it rather than replayed from another, and
 * `codeVerifier` proves the code is being spent by whoever asked for it.
 */
export interface Attempt {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

/**
 * Who the issuer says this is - what the register needs and nothing else.
 */
export interface Identity {
  /** Google's own name for the person, which never changes and is never reissued. */
  readonly subject: string;
  readonly email: string;
  /**
   * What they are called at Google, where it said. Read only when the register
   * has never seen them and has to call them something; anybody it already
   * holds keeps the name they were given there.
   */
  readonly name?: string;
}

/**
 * Why a reply was not believed.
 *
 * Every one of these is a refusal to sign anybody in, and none of them is ever
 * shown to whoever is signing in: they name what an attacker got wrong, so they
 * go to the log and the browser is told only that the sign-in failed.
 */
export type Refusal =
  | 'the sign-in did not begin here'
  | 'the reply belongs to another sign-in'
  | 'the issuer refused the sign-in'
  | 'no code came back'
  | 'the exchange was refused'
  | 'the identity could not be read'
  | 'the identity answers a different sign-in'
  | 'the address is not verified';

export type Verdict =
  | { readonly identified: true; readonly identity: Identity }
  | { readonly identified: false; readonly refusal: Refusal };

/**
 * A fresh attempt: three unguessable values from the platform's own CSPRNG.
 *
 * 256 bits each, because each of them is a secret whose only defence is being
 * unguessable - anybody able to predict `state` can complete a sign-in the
 * person did not start.
 */
export function newAttempt(random: Pick<Crypto, 'getRandomValues'> = crypto): Attempt {
  return {
    state: randomToken(random),
    nonce: randomToken(random),
    codeVerifier: randomToken(random),
  };
}

/**
 * Where to send the browser to be asked who it is.
 *
 * `code_challenge` is the SHA-256 of the verifier rather than the verifier
 * itself, so the value that travels through the browser is not the one that
 * spends the code. `prompt=select_account` because a person with two Google
 * accounts signed in has to be able to choose the one this Cockpit knows.
 */
export async function authorizationUrl(
  endpoints: IssuerEndpoints,
  clientId: string,
  redirectUri: string,
  attempt: Attempt,
): Promise<string> {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', attempt.state);
  url.searchParams.set('nonce', attempt.nonce);
  url.searchParams.set('code_challenge', await challengeFor(attempt.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/**
 * Whether the reply the browser came back with belongs to the attempt it
 * started - checked before anything is spent, because the whole point is to
 * refuse a reply somebody else's page caused.
 *
 * The attempt arriving as `null` is the case where the browser holds nothing:
 * a sign-in that was never started here, or one whose cookie is long gone. It
 * is refused by the same door as a mismatched one.
 */
export function replyBelongsTo(
  attempt: Attempt | null,
  reply: { state?: string | null; code?: string | null; error?: string | null },
): Refusal | null {
  if (!attempt) return 'the sign-in did not begin here';
  if (!reply.state || !timingSafeEquals(reply.state, attempt.state)) {
    return 'the reply belongs to another sign-in';
  }
  // The issuer's own refusal - the person pressed cancel, or was not permitted
  // - is checked after the state, so an unsolicited `?error=` proves nothing.
  if (reply.error) return 'the issuer refused the sign-in';
  if (!reply.code) return 'no code came back';
  return null;
}

/**
 * What an identity token is worth: signed by the issuer's current key, issued
 * by the issuer we asked, for this application, unexpired, and answering the
 * nonce this attempt sent.
 *
 * All five are `jwtVerify`'s to enforce rather than this function's to
 * re-implement, which is why the key set is a parameter: the tests hand in a
 * local one and mint tokens against it, so every refusal below is provable
 * without a network.
 */
export async function identityFrom(
  idToken: string,
  keys: JWTVerifyGetKey,
  expected: { issuer: string; clientId: string; nonce: string },
  now: Date,
): Promise<Verdict> {
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, keys, {
      issuer: expected.issuer,
      audience: expected.clientId,
      currentDate: now,
    }));
  } catch {
    // Which of the five it failed is deliberately not distinguished: there is
    // nothing to do differently, and nothing to learn from the difference.
    return { identified: false, refusal: 'the identity could not be read' };
  }

  if (typeof claims.nonce !== 'string' || !timingSafeEquals(claims.nonce, expected.nonce)) {
    return { identified: false, refusal: 'the identity answers a different sign-in' };
  }

  const subject = claims.sub;
  const email = claims.email;
  if (typeof subject !== 'string' || !subject || typeof email !== 'string' || !email) {
    return { identified: false, refusal: 'the identity could not be read' };
  }

  // **An unverified address is refused rather than trusted.** Anybody can put
  // any address on an account they own; `email_verified` is Google saying it
  // checked, and without it an address an admin added would be one anyone
  // could claim - and signing in as it would open that person's account.
  if (claims.email_verified !== true) {
    return { identified: false, refusal: 'the address is not verified' };
  }

  // A name is somebody's to leave out, so its absence is not a refusal: the
  // register falls back to the address (accounts/new-user.ts, `newcomerNamed`).
  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  return {
    identified: true,
    identity: { subject, email: normaliseAddress(email), ...(name ? { name } : {}) },
  };
}

/**
 * The one spelling of an address this application uses.
 *
 * The register holds an address as it is written and the unique index compares
 * it the same way (apps/api/src/db/schema.ts), so two spellings of one address
 * would be two people. Settling it here means every way in settles it the same
 * way, since this is the only place an address enters from Google.
 */
export function normaliseAddress(email: string): string {
  return email.trim().toLowerCase();
}

/** 256 bits, base64url, which is what every one of these values may contain. */
function randomToken(random: Pick<Crypto, 'getRandomValues'>): string {
  return base64url(random.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Compares in a time that does not depend on where two values first differ.
 *
 * `===` on a secret leaks its prefix to anybody who can measure the reply, and
 * `state` and `nonce` are secrets for exactly as long as one sign-in takes.
 * The lengths are compared first and openly: that a value is the wrong length
 * is not worth hiding.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
