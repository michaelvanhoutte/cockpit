import type { Connector } from '@cockpit/connector-sdk';
import { NOT_A_BELGIAN_MOBILE, belgianMobile } from './number.js';
import { checkCode, sendCode } from './verify.js';

/**
 * The Twilio connector: a phone connected by confirming a code Twilio Verify
 * texts to it ("Connect a phone in Settings by confirming a code texted to
 * it", issue 1335), so that a text from the phone can be captured by the next
 * unit.
 *
 * **Connecting is all it does yet.** It declares that it is pushed to
 * (`supportsPush`) but has no `handleWebhook`, so the ingress answers 404 and
 * its connections keep no delivery history until the push path lands.
 * Everything this package knows about Twilio is in its README.
 */

/**
 * Who this connector is, needing no configuration, so an Item it made is named
 * on screen in every environment (issue 927).
 */
export const TWILIO_IDENTITY = { id: 'twilio', displayName: 'Text messages' } as const;

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
      auth: { kind: 'texted-code', codesPerHour: CODES_PER_HOUR, textTo: config.number },
    },

    async sync() {
      // Nothing to pull: a text is pushed here.
    },

    numberFrom(typed) {
      const number = belgianMobile(typed);
      return number ? { number } : { refused: NOT_A_BELGIAN_MOBILE };
    },

    sendCode: (number) => sendCode(verify, number),
    checkCode: (number, code) => checkCode(verify, number, code),
  };
}

export { belgianMobile, NOT_A_BELGIAN_MOBILE } from './number.js';
export { VERIFY_ORIGIN } from './verify.js';
