//
// A stand-in Twilio Verify, for local development and the browser suite
// ("Connect a phone in Settings by confirming a code texted to it", issue
// 1335). The stub issuer (stub-issuer.mjs) serves it beside the sign-in, so one
// address stands in for Google's, Microsoft's and Twilio's.
//
// **No text reaches a phone from a laptop**, so where Verify would text a code
// this accepts the request and holds a verification for the number, and the
// code it will approve is always `123456`. It answers the two calls the Twilio
// connector makes (packages/connectors/twilio/README.md) at Verify's own paths
// and with Verify's own statuses: a check of a number nothing was sent to is a
// 404, a wrong code leaves the verification pending, and the fifth wrong code
// ends it. Nothing here ships.
//

/** The one code the stand-in approves. */
export const STAND_IN_CODE = '123456';

/** Wrong codes Verify allows before it ends a verification. */
const MOST_WRONG_CODES = 5;

/** Reads Verify's form-encoded body. */
function formOf(request, then) {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => then(new URLSearchParams(body)));
}

export function createStubVerify({ json }) {
  /** The numbers a code was sent to and not yet approved, with the wrong codes tried against each. */
  const pending = new Map();

  return {
    /** Answers a request at a Verify path, or says it is not one. */
    handle(url, request, response) {
      const match = url.pathname.match(/^\/v2\/Services\/([^/]+)\/(Verifications|VerificationCheck)$/);
      if (!match || request.method !== 'POST') return false;
      const [, serviceSid, resource] = match;

      // Basic credentials, as Twilio asks for; their value is not checked.
      if (!(request.headers.authorization ?? '').startsWith('Basic ')) {
        json(response, { code: 20003, message: 'Authenticate', status: 401 }, 401);
        return true;
      }

      formOf(request, (form) => {
        const to = form.get('To') ?? '';
        if (resource === 'Verifications') {
          if (!to) return json(response, { code: 60200, message: 'Invalid parameter: To', status: 400 }, 400);
          pending.set(to, 0);
          return json(response, { sid: `VE-stub-${pending.size}`, service_sid: serviceSid, to, channel: 'sms', status: 'pending' }, 201);
        }

        if (!pending.has(to)) {
          return json(response, { code: 20404, message: 'The requested resource was not found', status: 404 }, 404);
        }
        if (form.get('Code') === STAND_IN_CODE) {
          pending.delete(to);
          return json(response, { service_sid: serviceSid, to, status: 'approved', valid: true });
        }
        const wrong = pending.get(to) + 1;
        if (wrong >= MOST_WRONG_CODES) pending.delete(to);
        else pending.set(to, wrong);
        return json(response, { service_sid: serviceSid, to, status: 'pending', valid: false });
      });
      return true;
    },
  };
}
