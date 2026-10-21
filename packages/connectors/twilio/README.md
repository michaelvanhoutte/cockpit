# @cockpit/connector-twilio

Connects a phone by a code Twilio Verify texts to it ("Connect a phone in
Settings by confirming a code texted to it", issue 1335). The host runs the
conversation (`docs/architecture.md`, "Connectors: plugin-shaped, host-blind");
this package reads the number, asks Verify to text a code and asks it whether
the code typed back is that one. A connected phone's texts are captured by the
next unit, not here.

## The quirks, which is what this file is for

- **Verify holds everything about a code**: the code, its ten-minute expiry and
  its limit on wrong attempts. A check answers `approved`; `pending` for a wrong
  code (so it is `wrong`); and a 404 for a verification that does not exist,
  whether never sent, already approved or aged out (so it is `gone`). Any other
  status of an ended verification (`canceled`, `max_attempts_reached`,
  `expired`) is `gone` too, since nothing typed now can be right.
- **A 400 on a check is `wrong`**, which is how Verify answers a code it could
  not read as one. A 401, a 5xx or no answer at all is neither: the check
  throws `SourceError`, and nothing is connected.
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
