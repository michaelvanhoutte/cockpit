import { RefusedDelivery, type Connector, type PushHost } from '@cockpit/connector-sdk';
import { NOT_A_BELGIAN_MOBILE, belgianMobile } from './number.js';
import { isSignedByTwilio } from './signature.js';
import { checkCode, sendCode } from './verify.js';

/**
 * The Twilio connector: a phone is connected by confirming a code Twilio Verify
 * texts to it ("Connect a phone in Settings by confirming a code texted to
 * it", issue 1335), and a text from a connected phone to the Cockpit number is
 * captured as a note ("Text the Cockpit number and the note lands in the
 * Inbox", issue 1336). Everything this package knows about Twilio is in its
 * README.
 */

/**
 * Who this connector is, needing no configuration, so an Item it made is named
 * on screen in every environment (issue 927). The entry in Settings is *Text
 * messages*; one Item it made is a *Text message*.
 */
export const TWILIO_IDENTITY = { id: 'twilio', displayName: 'Text messages', itemSourceName: 'Text message' } as const;

/** What Twilio is answered when a text needs nothing sent back, which is every text: Cockpit never texts back. */
const NOTHING_TO_SAY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const answered = () => new Response(NOTHING_TO_SAY, { status: 200, headers: { 'content-type': 'text/xml' } });

/** The most a signed text's form is read to, so an unsigned request cannot make this read without end. */
const MOST_BYTES_READ = 64 * 1024;

/**
 * How many codes one account may ask for in an hour. Five covers a person who
 * mistyped a number or a code and starts again; it is the second guard against
 * SMS pumping, after the Belgian-mobile check and before Twilio's own
 * geographic permissions.
 */
export const CODES_PER_HOUR = 5;

/** What this connector needs to have been told about itself: what the environment holds. */
export interface TwilioConnectorConfig {
  readonly accountSid: string;
  readonly authToken: string;
  /** The Verify service the codes are sent through. */
  readonly verifyServiceSid: string;
  /** The Cockpit number a connected phone texts, in the form to show a person. */
  readonly number: string;
  /**
   * Where Verify is reached. Twilio's own by default; `pnpm dev` and the
   * browser suite point it at the stub issuer's stand-in, which accepts a fixed
   * code, since Twilio texts no phone on a laptop.
   */
  readonly verifyOrigin?: string;
}

export function createTwilioConnector(config: TwilioConnectorConfig): Connector {
  const verify = {
    accountSid: config.accountSid,
    authToken: config.authToken,
    serviceSid: config.verifyServiceSid,
    ...(config.verifyOrigin ? { origin: config.verifyOrigin } : {}),
  };

  return {
    manifest: {
      ...TWILIO_IDENTITY,
      cardText: 'Text a note to Cockpit from your phone. Cockpit texts you a code once, to check the number is yours.',
      supportsPush: true,
      // A text says nothing of which Workspace it is for: it is captured on
      // *Any workspace*, as the Car view's captures are, with the Workspace the
      // phone was connected from as where it came from.
      pushDecidesWorkspace: false,
      auth: { kind: 'texted-code', codesPerHour: CODES_PER_HOUR, textTo: config.number },
    },

    async sync() {
      // Nothing to pull: a text is pushed here.
    },

    /**
     * One text, decided in one pass: unsigned is refused with 403; from a
     * connected number it is captured, keyed on its `MessageSid`; from any other
     * it is dropped, logged with only the last four digits. **Every signed text
     * is answered 200 with an empty reply and nothing is ever texted back**, and
     * no text ever connects anything: only the code typed in Settings does.
     */
    async handleWebhook(request: Request, host: PushHost): Promise<Response> {
      const text = await signedTextFrom(request, config.authToken);
      if (!text) {
        host.log('warn', 'a request at the Twilio address was refused: Twilio did not sign it');
        return Response.json({ error: 'not signed by Twilio' }, { status: 403 });
      }

      const connection = text.from ? await host.forAccount(text.from) : null;
      if (!connection) {
        host.log('info', `a text from a number nobody has connected was dropped (number ending ${lastFour(text.from)})`);
        return answered();
      }
      if (!text.messageSid) {
        connection.log('warn', 'a signed text named no message and was dropped');
        return answered();
      }

      // Thrown after attribution, which is what writes the Failed line on the
      // connection; answered all the same, since a text with no words fails the
      // same way however often Twilio sends it.
      if (!text.body) {
        throw new RefusedDelivery('Cockpit read no words in this text.', answered());
      }

      // Left to throw on a failure of Cockpit's own: Twilio retries what got
      // no 200, and a `MessageSid` is one Item however often it is delivered.
      const filing = await connection.emitItem({
        sourceId: text.messageSid,
        capturedMessage: text.body,
        sourceLink: null,
        sender: null,
        sourceTimestamp: null,
      });
      connection.log(
        'info',
        filing === 'already-known' ? 'a text delivered again was already in Cockpit' : 'a text was captured',
      );
      return answered();
    },

    numberFrom(typed) {
      const number = belgianMobile(typed);
      return number ? { number } : { refused: NOT_A_BELGIAN_MOBILE };
    },

    sendCode: (number) => sendCode(verify, number),
    checkCode: (number, code) => checkCode(verify, number, code),
  };
}

/** What a text Twilio signed says: who sent it, which message it is, and its words. */
interface SignedText {
  from: string;
  messageSid: string;
  body: string;
}

/**
 * The text a request carries, or `null` where Twilio did not sign it. Judged
 * against the address as it was called and every parameter as it was sent, so
 * nothing in the request is read before it is believed.
 */
async function signedTextFrom(request: Request, authToken: string): Promise<SignedText | null> {
  const body = await boundedBody(request);
  if (body === null) return null;
  // The bytes as sent, decoded as the form they are rather than read as text.
  const params = new URLSearchParams(new TextDecoder().decode(body));
  if (!(await isSignedByTwilio(authToken, request.url, params, request.headers.get('x-twilio-signature')))) {
    return null;
  }
  return {
    from: (params.get('From') ?? '').trim(),
    messageSid: (params.get('MessageSid') ?? '').trim(),
    body: (params.get('Body') ?? '').trim(),
  };
}

/**
 * The body as sent, or `null` once it runs past `MOST_BYTES_READ`. Counted as it
 * arrives rather than taken from `Content-Length`, which a chunked request omits.
 */
async function boundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > MOST_BYTES_READ) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return whole;
}

/** The last four digits of a number, and nothing else of it, for a log line. */
function lastFour(from: string): string {
  const digits = from.replace(/\D/g, '');
  return digits.length > 0 ? digits.slice(-4) : 'unknown';
}

export { belgianMobile, NOT_A_BELGIAN_MOBILE } from './number.js';
export { isSignedByTwilio, signatureFor } from './signature.js';
export { VERIFY_ORIGIN } from './verify.js';
