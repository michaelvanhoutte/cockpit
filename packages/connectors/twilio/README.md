# @cockpit/connector-twilio

Connects a phone by a code Twilio Verify texts to it ("Connect a phone in
Settings by confirming a code texted to it", issue 1335). The host runs the
conversation (`docs/architecture.md`, "Connectors: plugin-shaped, host-blind");
this package reads the number, asks Verify to text a code and asks it whether
the code typed back is that one, and judges the texts a connected phone sends to
the Cockpit number ("Text the Cockpit number and the note lands in the Inbox",
issue 1336).

## The quirks, which is what this file is for

- **Verify holds everything about a code**: the code, its ten-minute expiry and
  its limit on wrong attempts. A check answers `approved`; `pending` for a wrong
  code (so it is `wrong`); and a 404 for a verification that does not exist,
  whether never sent, already approved or aged out (so it is `gone`). Any other
  status of an ended verification (`canceled`, `max_attempts_reached`,
  `expired`) is `gone` too, since nothing typed now can be right.
- **A 400 on a check is `wrong`**, which is how Verify answers a code it could
  not read as one, and **a 429 is `gone`**: Verify's limit on checks of one
  verification (error 60202). A 401, a 5xx, no answer at all or a 200 whose body
  cannot be read is neither: the check throws `SourceError`, and nothing is
  connected.
- **A send refused with 429 is Verify's own limit on codes to one number**, said
  as such; any other 4xx is "would not text that number", and a 5xx or no answer
  is "could not be reached". None of the messages names an address or a
  credential.
- **Calls are form-encoded and use the account SID and auth token as Basic
  credentials**, against `https://verify.twilio.com` unless `verifyOrigin` points
  elsewhere. Locally that is the stub issuer's stand-in
  (`scripts/lib/stub-verify.mjs`), which approves the code `123456`.
- **Only Belgian mobile numbers** (`+32 4` and eight digits) are accepted, in
  any way people write them. A landline has a shorter number after its area
  code, and `+32 4 123 45 67` is Liège's. This is the first of three guards
  against SMS pumping; the host's five codes an hour and Twilio's geographic
  permissions are the others.
- **No contract tier yet.** The recorded shapes in
  `apps/api/tests/integration/verify.ts` follow Twilio's documentation; they have
  not been checked against a real Verify service, which needs credentials this
  repository does not hold. Check them on the first live service.
- **A text is a form post to `/ingress/twilio/*`**, and the proof it is Twilio's
  is `X-Twilio-Signature`: the base64 HMAC-SHA1, under the auth token, of the
  address called followed by each parameter's name and value in name order
  (`src/signature.ts`; a worked example from Twilio's documentation is a test).
  The address is the one the request arrived at. **The retry settings after `#`
  on the configured address never reach a request**, and the signature is
  assumed to be over the address without them; unchecked against a real signed
  request, so a 403 on every text from the first live number starts there.
- **Every signed text is answered 200 with an empty `<Response>`**, so Twilio
  sends nothing back to the phone. A text with no words is the exception only in
  what it writes: `RefusedDelivery` gives the connection its *Failed* line and is
  still answered 200, since a retry would fail the same way.
- **`From` is the key the connection was stored under** (`+32470123456`), and
  `MessageSid` is the Item's source id, so Twilio's retries are one Item.
- **A log line about a number names its last four digits only.**
