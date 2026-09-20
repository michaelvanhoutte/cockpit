import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Connector, PushHost } from '@cockpit/connector-sdk';
import {
  bearerToken,
  OPEN_ID_METADATA_URL,
  refusesTheCaller,
  savedMessageFrom,
  type Refusal,
} from './activity.js';

/**
 * The Microsoft Teams connector: one message action, "Save to Cockpit"
 * ("Save a Teams message to Cockpit", issue 486).
 *
 * **Push only, today.** Teams' own Saved list has no Graph API
 * (docs/microsoft-teams-integration-options.md), so what an explicit save
 * means here is a click Teams delivers to this application rather than
 * something to go and read. `sync` therefore has nothing to pull; the
 * subscriptions that would give it something are their own later issues.
 *
 * Everything this package knows about Bot Framework calls, and everything a
 * developer has to do once by hand, is in its README.
 */

/** What this connector needs to have been told about itself. */
export interface TeamsConnectorConfig {
  /**
   * The Azure Bot resource's own Microsoft App ID, which is the audience of
   * every call the Bot Framework signs for it. A call minted for another bot
   * is refused against this, which is the whole of what stops another Teams
   * app reaching this address.
   */
  readonly appId: string;
  /**
   * Where the signing keys come from. Defaults to the Bot Framework's own
   * published set; handed in by the tests, which mint their own tokens and
   * must reach no network (docs/testing-strategy.md, "Third parties").
   */
  readonly keys?: JWTVerifyGetKey;
  /**
   * Which metadata document names those keys. Defaults to Microsoft's own, and
   * is pointed at the local stub by `pnpm dev` for the same reason `OIDC_ISSUER`
   * points signing in at one: there is no Teams to press a button in on a
   * laptop, and a path nobody can drive locally is one nobody checks.
   */
  readonly metadataUrl?: string;
  /** Read once per call, so a token is judged against the time it arrived. */
  readonly now?: () => Date;
}

export function createTeamsConnector(config: TeamsConnectorConfig): Connector {
  const keys = config.keys ?? botFrameworkKeys(config.metadataUrl ?? OPEN_ID_METADATA_URL);
  const now = config.now ?? (() => new Date());

  return {
    manifest: {
      id: 'teams',
      displayName: 'Microsoft Teams',
      source: 'teams',
      supportsPush: true,
      // Connecting an account is its own conversation with Microsoft, run by
      // the application rather than described here ("Connect a Microsoft Teams
      // source account", issue 485): the identity it asks for is the sign-in's
      // own, and a descriptor here would be a second copy of it.
      auth: { kind: 'none' },
    },

    async sync() {
      // Nothing to pull: a save is pushed here, and nothing else is subscribed
      // to yet. An empty pull rather than a missing method, the SPI asking
      // every connector for one.
    },

    async handleWebhook(request: Request, host: PushHost): Promise<Response> {
      const read = await savedMessageFrom(
        { token: bearerToken(request.headers.get('authorization')), activity: await bodyOf(request) },
        keys,
        { appId: config.appId },
        now(),
      );
      if (typeof read === 'string') {
        host.log('warn', `a call at the Teams address was refused: ${read}`);
        return refused(read);
      }

      // Only now, and only for this one key: what the call named is compared
      // against what is connected before anything of an account is opened.
      const connection = await host.forAccount(read.externalAccountKey);
      if (!connection) {
        host.log('info', 'a Teams save named an account no workspace has connected');
        return saidInTeams(
          'That Microsoft Teams account is not connected to a Cockpit workspace yet. Connect it under Manage connections and try again.',
        );
      }

      // Left to throw, and that is the retry: Teams redelivers an action it
      // got no 200 for, and the same message saved twice is one Item
      // (`sourceId`, activity.ts), so failing loudly is safe and losing the
      // save quietly is not.
      const filing = await connection.emitItem(read.item);
      if (filing === 'already-known') {
        connection.log('info', 'a Teams message saved again was already in Cockpit');
        return saidInTeams('Already in Cockpit.');
      }
      connection.log('info', 'a Teams message was saved to Cockpit');
      return saidInTeams('Saved to Cockpit.');
    },
  };
}

/**
 * What a refused call is told.
 *
 * **A refusal of the caller is a 401 and a refusal of the payload is a 400**,
 * which is the difference between "this address does not believe you" and
 * "Teams sent something this cannot use" - and neither is a 200, so nothing
 * that was not understood is ever reported back to Teams as saved.
 */
function refused(refusal: Refusal): Response {
  return Response.json({ error: refusal }, { status: refusesTheCaller(refusal) ? 401 : 400 });
}

/**
 * What Teams shows the person who clicked.
 *
 * A message action's reply is a task module response, and `message` is the
 * one that simply says something in the dialog Teams already has open -
 * nothing about a save belongs in the chat everybody else is reading. The
 * `composeExtension` results are a search command's replies: Teams answered
 * one to an action with a dialog reading "unsupported".
 */
function saidInTeams(text: string): Response {
  return Response.json({ task: { type: 'message', value: text } }, { status: 200 });
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * The Bot Framework's published signing keys, fetched once per isolate.
 *
 * The metadata document names the key set, and `jose` then keeps it fresh on
 * its own - so a key Microsoft rotates to is picked up without a deploy, and
 * a call whose key is not in the set is refused rather than fetched for on
 * every request.
 *
 * **Held per address rather than per connector**, which is what makes "once per
 * isolate" true: the application builds its connector list from the environment
 * on every request (`apps/api/src/connectors/registry.ts`), so a cache living in
 * `createTeamsConnector`'s own closure would be a new cache each time - two
 * round trips to Microsoft before any call could be judged, forged calls
 * included, which is an unauthenticated way to make this Cockpit hammer
 * somebody else's endpoint.
 */
const keysByMetadataUrl = new Map<string, JWTVerifyGetKey>();

function botFrameworkKeys(metadataUrl: string): JWTVerifyGetKey {
  const held = keysByMetadataUrl.get(metadataUrl);
  if (held) return held;

  let keys: Promise<JWTVerifyGetKey> | null = null;
  const getKey: JWTVerifyGetKey = async (header, input) => {
    keys ??= (async () => {
      const answer = await fetch(metadataUrl);
      if (!answer.ok) throw new Error(`the Bot Framework's keys could not be read: ${answer.status}`);
      const metadata = (await answer.json()) as { jwks_uri?: unknown };
      if (typeof metadata.jwks_uri !== 'string') {
        throw new Error("the Bot Framework's metadata names no key set");
      }
      return createRemoteJWKSet(new URL(metadata.jwks_uri));
    })().catch((failure: unknown) => {
      // Not cached as a rejection: a metadata read that failed once must not
      // refuse every call after it for as long as this isolate lives.
      keys = null;
      throw failure;
    });
    return (await keys)(header, input);
  };
  keysByMetadataUrl.set(metadataUrl, getKey);
  return getKey;
}

export { SAVE_COMMAND_ID, OPEN_ID_METADATA_URL, BOT_FRAMEWORK_ISSUER } from './activity.js';
