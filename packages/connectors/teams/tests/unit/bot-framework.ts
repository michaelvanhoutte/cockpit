import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { BOT_FRAMEWORK_ISSUER } from '../../src/activity.js';

/**
 * A Bot Framework that can be reached from inside a unit test: a key pair
 * standing in for the one Microsoft publishes, and calls signed with it.
 *
 * **No network, which is what keeps these at L1** (docs/testing-strategy.md):
 * the key set is handed to the connector rather than fetched, exactly as the
 * sign-in tests hand one to `claimsFrom`. Whether the real endpoint still
 * publishes what this stands in for is `tests/contract/`'s question.
 */

export const BOT_APP_ID = '11111111-2222-3333-4444-555555555555';
export const ANOTHER_BOT_APP_ID = '99999999-8888-7777-6666-555555555555';
export const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

export const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
export const PERSON = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091';
export const CONVERSATION = '19:meeting_abc123@thread.v2';
export const MESSAGE_ID = '1757930400000';
/** The id Teams gives the click itself, which `saveToCockpitCall` carries unless told otherwise. */
export const ACTIVITY_ID = 'f:7194316379412500000';

let pair: CryptoKeyPair | null = null;
let impostor: CryptoKeyPair | null = null;

async function signingPair(): Promise<CryptoKeyPair> {
  pair ??= await generateKeyPair('RS256', { extractable: true });
  return pair;
}

async function impostorPair(): Promise<CryptoKeyPair> {
  impostor ??= await generateKeyPair('RS256', { extractable: true });
  return impostor;
}

/** The keys the channel publishes - and the only ones it does. */
export async function channelKeys(): Promise<JWTVerifyGetKey> {
  return createLocalJWKSet(await publishedKeySet());
}

/**
 * The same keys as the document Microsoft publishes them in, for the one case
 * that drives the fetch itself rather than being handed the set.
 */
export async function publishedKeySet(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey } = await signingPair();
  return { keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig' }] };
}

export interface TokenWanted {
  audience?: string;
  issuer?: string;
  serviceUrl?: string;
  /** Seconds from now; negative for a token that has already run out. */
  expiresIn?: number;
  /** Signed with a key the channel does not publish - a forgery. */
  forged?: boolean;
}

export async function channelToken(wanted: TokenWanted = {}): Promise<string> {
  const { privateKey } = wanted.forged ? await impostorPair() : await signingPair();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ serviceurl: wanted.serviceUrl ?? SERVICE_URL })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(wanted.issuer ?? BOT_FRAMEWORK_ISSUER)
    .setAudience(wanted.audience ?? BOT_APP_ID)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + (wanted.expiresIn ?? 600))
    .sign(privateKey);
}

/**
 * What Teams posts when somebody picks "Save to Cockpit" on a message - the
 * shape Microsoft documents for `composeExtension/submitAction`, trimmed to the
 * fields anything reads.
 */
export function saveToCockpitCall(changed: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'invoke',
    id: ACTIVITY_ID,
    name: 'composeExtension/submitAction',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: {
      id: '29:1abc',
      name: 'Ada Lovelace',
      aadObjectId: PERSON,
    },
    conversation: { id: CONVERSATION, conversationType: 'groupChat', tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    value: {
      commandId: 'saveToCockpit',
      commandContext: 'message',
      messagePayload: {
        id: MESSAGE_ID,
        createdDateTime: '2026-09-15T09:20:00.000Z',
        linkToMessage: `https://teams.microsoft.com/l/message/${CONVERSATION}/${MESSAGE_ID}?tenantId=${TENANT}`,
        body: {
          contentType: 'html',
          content: '<div>Can you review the <b>Q3 plan</b> before Friday?</div>',
        },
        from: { user: { id: '29:2def', displayName: 'Grace Hopper' } },
      },
    },
    ...changed,
  };
}
