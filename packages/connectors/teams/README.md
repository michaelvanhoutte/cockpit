# @cockpit/connector-teams

A "Save to Cockpit" action on a Teams message. Teams delivers the click to
`POST /ingress/teams/…`; this package proves the call is the Bot Framework's,
reads the message out of it, and says which connected account it is for. The
host does the rest ("Save a Teams message to Cockpit", issue 486).

## The quirks, which is what this file is for

- **A message action needs a real Azure Bot resource.** The simpler
  bot-less message extension supports search commands only, so an action
  command has no way to reach an application without one.
- **The call is signed by the channel, not by the person.** The bearer token
  is issued by `https://api.botframework.com` with the bot's own App ID as its
  audience, and it carries no user identity at all. Who saved the message is in
  the *body* — and is worth nothing until the token has proved the body came
  from Teams. That ordering is the whole of `activity.ts`.
- **A token minted for another bot is its own refusal.** Every Teams app in the
  world can be pointed at this address, and such a call is genuinely signed,
  unexpired, and not ours. So the audience is checked here rather than handed to
  `jwtVerify`, which would fold it into "could not be read".
- **`serviceurl` is a claim, lower-case and unlike every other claim name.** It
  must equal the activity's own `serviceUrl`, which is what stops a replayed
  body being answered to an address the attacker chose.
- **The keys are public and rotate.** They are found through
  `https://login.botframework.com/v1/.well-known/openidconfiguration`, never
  written down here. `tests/contract/` asks the real endpoint whether that is
  still true, on a schedule.
- **`messagePayload.id` is unique within a conversation, not globally**, so what
  identifies the saved message — and so what makes a redelivered click one Item
  rather than two — is the conversation and the message together.
- **A message body is HTML unless it says otherwise**, so what is captured is
  the text with its tags taken out.
- **The reply is a `composeExtension` result, not an empty 200.** `type:
  "message"` says something to whoever clicked without putting a card into the
  conversation everybody else is reading.

## Setting it up (once, by hand)

Not automated, and deliberately: an Entra registration and an Azure Bot are
one-time developer setup per environment (issue 486, "Out of scope").

1. Create an **Azure Bot** resource with a Microsoft App ID (single-tenant or
   multi-tenant, matching how the Entra app for connecting accounts was
   registered).
2. Point its **messaging endpoint** at `https://<app origin>/ingress/teams/messages`.
3. Enable the **Microsoft Teams** channel on it.
4. Put the App ID in this environment: `wrangler secret put MS_BOT_APP_ID`
   (and again with `--env staging`). Without it, the address answers 404 and
   nothing else about the application changes.
5. Fill in `teams-app/manifest.json` (App ID, origin, icons), zip it with a
   192×192 `color.png` and a 32×32 transparent `outline.png`, and upload it in
   Teams. The tenant's custom-app-upload policy has to allow that — an admin
   toggle, not a licence.
6. In Cockpit, connect that Microsoft account to a workspace under **Manage
   connections**, so a save has somewhere to land.

## Levels

- `tests/unit/` — every refusal and every reading, against tokens minted in the
  test. No network.
- `tests/contract/` — scheduled only: Microsoft still publishes the metadata,
  the key set and the issuer this package assumes.
- The route, the identity resolution and the Item that comes out of it are
  proved in `apps/api/tests/integration/http/teams-ingress.test.ts`, entered the
  way Teams enters it.
