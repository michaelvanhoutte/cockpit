import { vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/**
 * A Bot Framework that can be reached from inside a test.
 *
 * Teams is horizontal - another service, over the network - which L2 may not
 * touch (docs/testing-strategy.md, "Test level definitions and dependency
 * restrictions"). So it is faked at the network boundary and nothing else is:
 * the application fetches the published metadata itself, builds its own key set
 * from it and checks the signature itself, exactly as it does against
 * Microsoft. Whether Microsoft still publishes what this stands in for is the
 * connector's own contract tier
 * (packages/connectors/teams/tests/contract/bot-framework-keys.test.ts).
 *
 * The payloads are the shape Microsoft documents for a message action's
 * `composeExtension/submitAction`, not one invented here.
 */

const METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const KEYS = 'https://login.botframework.com/v1/.well-known/keys';
const ISSUER = 'https://api.botframework.com';

/** The bot this Cockpit is, which is what `MS_BOT_APP_ID` says (vitest.config.ts). */
export const BOT_APP_ID = '11111111-2222-3333-4444-555555555555';
export const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

export const TEAMS_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
export const TEAMS_PERSON = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091';
export const CONVERSATION = '19:meeting_abc123@thread.v2';
export const MESSAGE_ID = '1757930400000';

let keys: CryptoKeyPair | null = null;
let impostor: CryptoKeyPair | null = null;

async function signingKeys(): Promise<CryptoKeyPair> {
  keys ??= await generateKeyPair('RS256', { extractable: true });
  return keys;
}

async function impostorKeys(): Promise<CryptoKeyPair> {
  impostor ??= await generateKeyPair('RS256', { extractable: true });
  return impostor;
}

/**
 * Puts the channel's published keys on the network: where the metadata is, and
 * what it signs with.
 *
 * Stubs every time rather than once, for the reason `issuerIsReachable` does:
 * a case that unstubs would otherwise leave the next one reaching for the real
 * internet with nothing noticing.
 */
export async function botFrameworkIsReachable(): Promise<void> {
  const { publicKey } = await signingKeys();
  const published = {
    keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'the-channel-key' }],
  };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== 'https://login.botframework.com') {
      throw new Error(`nothing in a test may reach ${url.origin}`);
    }
    if (url.href === METADATA) {
      return Response.json({
        issuer: ISSUER,
        jwks_uri: KEYS,
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url.href === KEYS) return Response.json(published);
    throw new Error(`the channel has no ${url.pathname}`);
  });
}

export interface TokenWanted {
  audience?: string;
  serviceUrl?: string;
  /** Seconds from now; negative for a token that has already run out. */
  expiresIn?: number;
  /** Signed with a key the channel does not publish. */
  forged?: boolean;
}

/** A channel token, as the Bot Framework signs one for this bot. */
export async function channelToken(wanted: TokenWanted = {}): Promise<string> {
  const { privateKey } = wanted.forged ? await impostorKeys() : await signingKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ serviceurl: wanted.serviceUrl ?? SERVICE_URL })
    .setProtectedHeader({ alg: 'RS256', kid: 'the-channel-key' })
    .setIssuer(ISSUER)
    .setAudience(wanted.audience ?? BOT_APP_ID)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + (wanted.expiresIn ?? 600))
    .sign(privateKey);
}

export interface SaveWanted {
  tenant?: string;
  person?: string;
  messageId?: string;
  said?: string;
  commandId?: string;
  /** The click's own id: what one press is, and what a redelivery of it repeats. */
  activityId?: string;
}

/** What Teams posts when somebody picks "Save to Cockpit" on a message. */
export function saveToCockpitCall(wanted: SaveWanted = {}): Record<string, unknown> {
  const messageId = wanted.messageId ?? MESSAGE_ID;
  const tenant = wanted.tenant ?? TEAMS_TENANT;
  return {
    type: 'invoke',
    id: wanted.activityId ?? 'f:7194316379412500000',
    name: 'composeExtension/submitAction',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: '29:1abc', name: 'Ada Lovelace', aadObjectId: wanted.person ?? TEAMS_PERSON },
    conversation: { id: CONVERSATION, conversationType: 'groupChat', tenantId: tenant },
    channelData: { tenant: { id: tenant } },
    value: {
      commandId: wanted.commandId ?? 'saveToCockpit',
      commandContext: 'message',
      messagePayload: {
        id: messageId,
        createdDateTime: '2026-09-15T09:20:00.000Z',
        linkToMessage: `https://teams.microsoft.com/l/message/${CONVERSATION}/${messageId}?tenantId=${tenant}`,
        body: {
          contentType: 'html',
          content: `<div>${wanted.said ?? 'Can you review the <b>Q3 plan</b> before Friday?'}</div>`,
        },
        from: { user: { id: '29:2def', displayName: 'Grace Hopper' } },
      },
    },
  };
}
