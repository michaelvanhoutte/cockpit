import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import {
  authorizationUrl,
  identityFrom,
  newAttempt,
  replyBelongsTo,
  type Attempt,
  type IssuerEndpoints,
} from '../../../src/auth/oidc.js';

/**
 * L1, and exhaustive on purpose: this is the code that decides who you are, and
 * docs/architecture.md ("App login: hand-rolled Google OIDC + own sessions")
 * asks for every branch of it to be proved here rather than sampled higher up.
 * Everything it needs is local - a key pair minted in this file, a clock handed
 * in - so each refusal below is a real token failing a real check, with no
 * network and nothing stubbed.
 *
 * What it cannot prove is that any of this is on the request path. That is
 * tests/integration/http/sign-in.test.ts, which walks the whole flow against
 * the stub issuer once and deliberately does not re-prove the branching here.
 */

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'cockpit.apps.googleusercontent.com';
const NOW = new Date('2026-09-06T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const endpoints: IssuerEndpoints = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  jwksUri: `${ISSUER}/jwks`,
};

const attempt: Attempt = {
  state: 'the-state-this-sign-in-sent',
  nonce: 'the-nonce-this-sign-in-sent',
  codeVerifier: 'the-verifier-this-sign-in-kept',
};

let ours: CryptoKeyPair;
let somebodyElses: CryptoKeyPair;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  ours = await generateKeyPair('RS256', { extractable: true });
  somebodyElses = await generateKeyPair('RS256', { extractable: true });
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(ours.publicKey)), alg: 'RS256' }] });
});

/** An identity token, correct in every way but whatever the case changes. */
function identityToken(
  changes: {
    issuer?: string;
    audience?: string;
    nonce?: string;
    subject?: string;
    expiresAt?: Date;
    signedBy?: CryptoKeyPair;
    claims?: Record<string, unknown>;
  } = {},
): Promise<string> {
  return new SignJWT({
    nonce: changes.nonce ?? attempt.nonce,
    email: 'michael@example.com',
    email_verified: true,
    ...changes.claims,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(changes.issuer ?? ISSUER)
    .setAudience(changes.audience ?? CLIENT_ID)
    .setSubject(changes.subject ?? 'google-michael')
    .setIssuedAt(NOW)
    .setExpirationTime(changes.expiresAt ?? new Date(NOW.getTime() + HOUR))
    .sign((changes.signedBy ?? ours).privateKey);
}

function verdictFor(token: string, nonce = attempt.nonce) {
  return identityFrom(token, keys, { issuer: ISSUER, clientId: CLIENT_ID, nonce }, NOW);
}

describe('Sign-in', () => {
  describe('a sign-in only completes for the browser that started it', () => {
    it('lets through a reply carrying the proof this browser was given', () => {
      expect(replyBelongsTo(attempt, { state: attempt.state, code: 'a-code' })).toBeNull();
    });

    it.each([
      {
        situation: 'a reply carrying no proof it began here',
        held: null,
        reply: { state: attempt.state, code: 'a-code' },
      },
      {
        situation: "a reply carrying another sign-in's proof",
        held: attempt,
        reply: { state: 'a-state-from-somewhere-else', code: 'a-code' },
      },
      {
        situation: 'a reply carrying no proof at all',
        held: attempt,
        reply: { code: 'a-code' },
      },
      {
        situation: 'a reply the issuer refused',
        held: attempt,
        reply: { state: attempt.state, error: 'access_denied' },
      },
      {
        situation: 'a reply with nothing to exchange',
        held: attempt,
        reply: { state: attempt.state },
      },
    ])('refuses $situation', ({ held, reply }) => {
      expect(replyBelongsTo(held, reply)).not.toBeNull();
    });

    /**
     * A refusal the issuer sent is checked *after* the proof, so a page that
     * simply navigates a browser to the callback with `?error=` learns nothing
     * about whether a sign-in was in flight.
     */
    it('asks whether the reply belongs here before it reads what it says', () => {
      expect(replyBelongsTo(attempt, { error: 'access_denied' })).toBe(
        'the reply belongs to another sign-in',
      );
    });

    it('gives every sign-in its own three secrets', () => {
      const one = newAttempt();
      const other = newAttempt();
      expect(new Set([...Object.values(one), ...Object.values(other)]).size).toBe(6);
    });
  });

  describe('an identity is believed only when the issuer signed it for this sign-in', () => {
    it('reads who somebody is from an identity with nothing wrong with it', async () => {
      await expect(verdictFor(await identityToken())).resolves.toEqual({
        identified: true,
        identity: { subject: 'google-michael', email: 'michael@example.com' },
      });
    });

    it.each([
      { situation: 'an identity issued for another application', changes: { audience: 'somebody-elses-app' } },
      { situation: 'an identity from another issuer', changes: { issuer: 'https://not-the-issuer.test' } },
      { situation: 'an identity signed with a key that is not the issuer’s', changes: {} },
      {
        situation: 'an identity that has expired',
        changes: { expiresAt: new Date(NOW.getTime() - HOUR) },
      },
      {
        situation: 'an identity answering a different sign-in',
        changes: { nonce: 'the-nonce-of-some-other-sign-in' },
      },
      { situation: 'an identity answering no sign-in at all', changes: { claims: { nonce: null } } },
      {
        situation: 'an identity carrying an address Google has not verified',
        changes: { claims: { email_verified: false } },
      },
      {
        situation: 'an identity carrying no address',
        changes: { claims: { email: null } },
      },
      { situation: 'an identity naming nobody', changes: { subject: '' } },
    ])('refuses $situation', async ({ situation, changes }) => {
      const token = await identityToken(
        situation.includes('not the issuer’s') ? { signedBy: somebodyElses } : changes,
      );
      await expect(verdictFor(token)).resolves.toMatchObject({ identified: false });
    });

    it('refuses anything that is not an identity token at all', async () => {
      await expect(verdictFor('not.a.token')).resolves.toMatchObject({ identified: false });
    });

    /**
     * Two spellings of one address would be two people in a register that
     * compares them exactly, so the one place an address enters from Google is
     * where the spelling is settled.
     */
    it('settles on one spelling of an address', async () => {
      const token = await identityToken({ claims: { email: '  Michael@Example.COM ' } });
      await expect(verdictFor(token)).resolves.toMatchObject({
        identity: { email: 'michael@example.com' },
      });
    });

    /**
     * `profile` is asked for so that somebody nobody added has something to be
     * called, and their name is the one thing kept from it: a picture or a
     * locale arriving beside it is somebody else's decision in our data, and
     * nothing downstream can start depending on it by accident.
     */
    it('keeps who it names, the address and what they are called, and nothing else', async () => {
      const token = await identityToken({
        claims: { name: '  Rita Recruiter ', picture: 'https://...' },
      });
      await expect(verdictFor(token)).resolves.toEqual({
        identified: true,
        identity: { subject: 'google-michael', email: 'michael@example.com', name: 'Rita Recruiter' },
      });
    });

    /** A name is somebody's to leave out, so going without one refuses nothing. */
    it.each([
      { situation: 'no name at all', claims: {} },
      { situation: 'a name of nothing but spaces', claims: { name: '   ' } },
      { situation: 'a name that is not text', claims: { name: 42 } },
    ])('believes an identity carrying $situation, and keeps no name from it', async ({ claims }) => {
      await expect(verdictFor(await identityToken({ claims }))).resolves.toEqual({
        identified: true,
        identity: { subject: 'google-michael', email: 'michael@example.com' },
      });
    });
  });

  describe('the browser is sent away with what proves the sign-in, never with what spends it', () => {
    it('asks the issuer for an identity, answering this attempt', async () => {
      const url = new URL(await authorizationUrl(endpoints, CLIENT_ID, 'https://app.test/back', attempt));
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: CLIENT_ID,
        redirect_uri: 'https://app.test/back',
        response_type: 'code',
        scope: 'openid email profile',
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge_method: 'S256',
      });
    });

    it('sends the challenge rather than the verifier', async () => {
      const url = new URL(await authorizationUrl(endpoints, CLIENT_ID, 'https://app.test/back', attempt));
      const challenge = url.searchParams.get('code_challenge');
      expect(challenge).not.toBe(attempt.codeVerifier);
      expect(url.toString()).not.toContain(attempt.codeVerifier);
      // The SHA-256 of the verifier, base64url, as PKCE defines it - taken from
      // `node -e "createHash('sha256').update(verifier).digest('base64url')"`
      // rather than from the code under test, which would agree with itself
      // however it hashed.
      expect(challenge).toBe('jYr00OZTFqwBdHW1Zl5ypt76FlnNqV7GgR3SQrsr_vE');
    });
  });
});
