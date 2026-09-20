import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { SourceItem } from '@cockpit/connector-sdk';

/**
 * What a "Save to Cockpit" click is worth, and what it says once it is worth
 * anything ("Save a Teams message to Cockpit", issue 486).
 *
 * **Everything Teams sends arrives at one address, from the internet, for every
 * connected account at once.** So nothing in the body is believed until the
 * call itself has been proved to be the Bot Framework's: the body names the
 * tenant and the person, and a body anybody may post is a body anybody may
 * write somebody else's name into.
 *
 * Pure but for the signature check, which is handed in exactly as `claimsFrom`
 * hands its key set in (apps/api/src/auth/oidc.ts) - so every refusal below is
 * provable at L1 against tokens minted in the test, with no network.
 */

/** Who signs a channel's calls, and the only issuer this believes. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';

/** Where the Bot Framework publishes the keys it signs those calls with. */
export const OPEN_ID_METADATA_URL =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';

/** What the message action is called in the Teams app manifest, and in the call. */
export const SAVE_COMMAND_ID = 'saveToCockpit';

/** How long an Item's title may be, which the contract also says (`TITLE_LENGTH`). */
const TITLE_LENGTH = 200;

/** The one activity a message action arrives as. */
const SUBMIT_ACTION = 'composeExtension/submitAction';

/**
 * Why a call was not acted on - the log's words, never a person's.
 *
 * The first three are refusals of the call itself and the last three are
 * refusals of what it carried, which is the difference between "somebody is
 * posting at this address" and "Teams sent something this cannot use".
 */
export type Refusal =
  | 'the call was not signed by the Bot Framework'
  | 'the call was signed for another bot'
  | 'the call names another address'
  | 'the call is not a save'
  | 'the call carries no message'
  | 'the call names nobody';

/** Whether a refusal is about the caller rather than about what it sent. */
export function refusesTheCaller(refusal: Refusal): boolean {
  return (
    refusal === 'the call was not signed by the Bot Framework' ||
    refusal === 'the call was signed for another bot' ||
    refusal === 'the call names another address'
  );
}

/** A save, read out of a call that has been proved genuine. */
export interface SavedMessage {
  /**
   * Which account at Microsoft saved it, in the same terms the connection was
   * stored under when somebody connected their Teams account: the tenant and
   * the person's object id (`apps/api/src/connectors/teams.ts`).
   */
  readonly externalAccountKey: string;
  readonly item: SourceItem;
}

/** What the call carries, as far as anything here reads it. */
interface Activity {
  /** The click's own id - what a redelivery of the same click is recognized by. */
  id?: unknown;
  type?: unknown;
  name?: unknown;
  serviceUrl?: unknown;
  conversation?: { id?: unknown; tenantId?: unknown };
  channelData?: { tenant?: { id?: unknown } };
  from?: { aadObjectId?: unknown };
  value?: { commandId?: unknown; messagePayload?: MessagePayload };
}

interface MessagePayload {
  id?: unknown;
  createdDateTime?: unknown;
  linkToMessage?: unknown;
  body?: { content?: unknown; contentType?: unknown };
  from?: { user?: { displayName?: unknown } };
}

/**
 * The save this call is, or why it is not one.
 *
 * The order is the point: the token first, then what the token permits us to
 * read. Nothing about the account is looked up here at all - who this is for
 * is answered, and the host is what turns that answer into a connection.
 *
 * `newId` names a click that arrives without an id of its own, so that a save
 * is never taken for another one; it is handed in, like `now`, to keep this a
 * function of its arguments.
 */
export async function savedMessageFrom(
  call: { token: string; activity: unknown },
  keys: JWTVerifyGetKey,
  expected: { appId: string },
  now: Date,
  newId: () => string,
): Promise<SavedMessage | Refusal> {
  let claims;
  try {
    // The audience is deliberately *not* given to `jwtVerify`, which is the
    // one deviation from how signing in verifies a token (auth/oidc.ts): a
    // token minted for another bot is a different fact about the world from a
    // forged one - somebody's real Teams app pointed at this address - and
    // folding the two would lose it. Everything else (signature, issuer,
    // expiry, not-before) is `jose`'s to enforce rather than this to
    // re-implement.
    ({ payload: claims } = await jwtVerify(call.token, keys, {
      issuer: BOT_FRAMEWORK_ISSUER,
      currentDate: now,
    }));
  } catch {
    return 'the call was not signed by the Bot Framework';
  }

  if (!audienceIs(claims.aud, expected.appId)) return 'the call was signed for another bot';

  const activity = (isObject(call.activity) ? call.activity : {}) as Activity;

  // **The address the reply would go to is signed into the token**, so a call
  // carrying somebody else's `serviceUrl` is refused here rather than believed
  // and answered to wherever it points.
  const signedFor = text(claims.serviceurl);
  if (!signedFor || !sameAddress(signedFor, text(activity.serviceUrl))) {
    return 'the call names another address';
  }

  if (
    text(activity.type) !== 'invoke' ||
    text(activity.name) !== SUBMIT_ACTION ||
    text(activity.value?.commandId) !== SAVE_COMMAND_ID
  ) {
    return 'the call is not a save';
  }

  // Tenant and object id, the pair a Teams connection is keyed on. `tid` from
  // the conversation where it is there and from the channel data otherwise,
  // which is where Teams puts it for a channel rather than a chat.
  const tenant = text(activity.conversation?.tenantId) || text(activity.channelData?.tenant?.id);
  const person = text(activity.from?.aadObjectId);
  if (!tenant || !person) return 'the call names nobody';

  const message = activity.value?.messagePayload;
  const conversation = text(activity.conversation?.id);
  const messageId = text(message?.id);
  const said = plainText(message?.body);
  if (!message || !conversation || !messageId || !said) return 'the call carries no message';

  return {
    externalAccountKey: `${tenant}:${person}`,
    item: {
      source: 'teams',
      // **The click, not the message.** Every press of Save files an Item and
      // Cockpit's own duplicate mark says when two are one note, while a click
      // Teams delivers again keeps its id and so lands on the Item it made.
      // Message ids are unique only within a conversation, so both are named.
      sourceId: `${conversation}:${messageId}:${text(activity.id) || newId()}`,
      sourceLink: deepLink(message, conversation, messageId, tenant),
      // **Cut to what an Item may carry** (`capturedFrom` in the contract),
      // Entra allowing a display name half as long again as a title. What the
      // host refuses it cannot file, and a save the host refuses is one Teams
      // redelivers forever - so the trimming belongs on this side of the SPI,
      // where the shape emitted is the connector's own business.
      sender: cutTo(text(message.from?.user?.displayName), TITLE_LENGTH) || null,
      sourceTimestamp: timestamp(message.createdDateTime),
      title: oneLine(said),
      capturedMessage: said,
    },
  };
}

/** The bearer token a call carries, or the empty string where it carries none. */
export function bearerToken(authorization: string | null): string {
  const match = /^Bearer\s+(\S+)$/i.exec((authorization ?? '').trim());
  return match?.[1] ?? '';
}

/**
 * Whether a token minted for `appId` says so. `aud` is one value or a list of
 * them, which is the JWT specification rather than anything about Microsoft.
 */
function audienceIs(aud: unknown, appId: string): boolean {
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
  return audiences.some((one) => typeof one === 'string' && one === appId);
}

/** Two service addresses are the same address whether or not one ends in a slash. */
function sameAddress(a: string, b: string): boolean {
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase() && b !== '';
}

/**
 * Where the message is in Teams.
 *
 * Teams sends `linkToMessage` with a message action, and it is preferred over
 * anything built here: it is the client's own link, and it is what opens in the
 * app rather than in a browser tab that then has to redirect. The fallback is
 * the documented shape of that same link, for a payload that arrives without
 * one.
 *
 * **It has to parse as well as start with `https://`**, for the reason `sender`
 * above is cut: an Item's `sourceLink` is a URL the host refuses if it is not
 * one, and a refusal here would be a save Teams redelivers for ever rather than
 * a save that arrives without its way back.
 */
function deepLink(
  message: MessagePayload,
  conversation: string,
  messageId: string,
  tenant: string,
): string | null {
  const given = text(message.linkToMessage);
  if (given.startsWith('https://') && URL.canParse(given)) return given;
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(conversation)}/${encodeURIComponent(messageId)}?tenantId=${encodeURIComponent(tenant)}`;
}

/**
 * What the message says, as characters.
 *
 * A Teams message body is HTML unless it says otherwise, and what is captured
 * is the note somebody will read in their Inbox - so the tags come out here
 * rather than being stored for every reader to strip again. Nothing is
 * interpreted: the five entities XML defines are put back and everything else
 * is left exactly as it was written.
 */
function plainText(body: MessagePayload['body']): string {
  const content = text(body?.content);
  if (!content) return '';
  if (text(body?.contentType).toLowerCase() !== 'html') return content;
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What was said, as one line - the name the Item carries until Cockpit reads
 * it. The same rule the host applies to the captured message itself
 * (`textsFromCapture`, packages/shared), said here because a connector
 * normalizes what it emits and may not import the application's contract.
 */
function oneLine(said: string): string {
  return cutTo(said.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim(), TITLE_LENGTH);
}

/**
 * As much of what was said as the contract's own limit holds, never half of a
 * character - the rule `cutTo` in packages/shared already keeps, said again
 * here because a connector may not import the application's contract.
 */
function cutTo(said: string, limit: number): string {
  if (said.length <= limit) return said;
  const lead = said.charCodeAt(limit - 1);
  return said.slice(0, lead >= 0xd800 && lead <= 0xdbff ? limit - 1 : limit).trim();
}

/** When the message was sent, as an instant, or null where Teams said nothing usable. */
function timestamp(value: unknown): string | null {
  const said = text(value);
  if (!said) return null;
  const at = new Date(said);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
