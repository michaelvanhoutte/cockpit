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
- **What identifies a save is the click, not the message.** Every press of Save
  files an Item, and Cockpit's own possible-duplicate mark is what says two are
  one note, so the name is `conversation:message:activity id` — the activity's
  own top-level `id`, which is what makes a click Teams delivers again one Item.
  `messagePayload.id` is unique within a conversation, not globally, hence the
  conversation. **Unverified:** that Teams keeps the same activity `id` when it
  redelivers an invoke; if it does not, a retry files a second Item, which the
  duplicate mark then flags. A click with no usable `id` gets a fresh random one
  rather than none, so two saves are never taken for one.
- **A message body is HTML unless it says otherwise**, so what is captured is
  the text with its tags taken out.
- **The reply is a task-module message.** `{ task: { type: "message", value } }`
  says something to whoever clicked, in the dialog Teams already has open,
  without putting a card into the conversation everybody else is reading. It
  replaced `{ composeExtension: { type: "message" } }`, which Teams answered with
  a dialog reading "unsupported": Microsoft's list of replies to an action
  command has `composeExtension` results that insert a card and no `message`
  among them. The task reply is not on that list either, and has not yet been
  confirmed in a real Teams client.
- **The manifest asks for `identity` and nothing else.** A tenant admin weighs
  what the uploaded app may do, and saving a message needs only the payload the
  action already carries — `messageTeamMembers`, which an earlier draft asked
  for, would have let this app message every member of a team.
- **Where the action is offered is a separate matter, and `bots` is the only
  place the manifest names scopes.** `composeExtensions` has none; `bots` has
  (`personal`, `team`, `groupChat`), and its `botId` has to be the message
  extension's own. Observed: with no `bots` entry the action appeared in a
  channel and not in the one chat tried, a chat with yourself. Inferred, not
  documented: that the scopes are what decides it. Microsoft's schema pages
  define them on `bots` alone and say nothing about a chat with yourself, so
  whether that chat offers the action is still to be seen. **A `bots` entry
  also makes the bot addressable**: Teams may send it a `message` when somebody
  types in a chat with it, and events when the app is installed, and the
  endpoint answers any call that is not a save with a 400 and a warning in the
  log.
- **The manifest carries only properties its schema defines.** Teams refuses an
  upload for one it does not, and the first invented one (`packageName`) was
  found by uploading; `tests/unit/the-teams-app-manifest.test.ts` holds it.

## Setting it up (once, by hand)

Not automated, and deliberately: an Entra registration and an Azure Bot are
one-time developer setup per environment (issue 486, "Out of scope").

1. Create an **Azure Bot** resource with a Microsoft App ID, **single-tenant**:
   Microsoft stopped creating new multi-tenant bots after 31 July 2025, so only
   the bot's own tenant can install this app. The Entra app for connecting
   accounts is a separate, multi-tenant registration and does not have to match.
2. Point its **messaging endpoint** at `https://<app origin>/ingress/teams/messages`.
3. Enable the **Microsoft Teams** channel on it.
4. Put the App ID in this environment: `wrangler secret put MS_BOT_APP_ID`
   (and again with `--env staging`). Without it, the address answers 404 and
   nothing else about the application changes.
5. Fill in `teams-app/manifest.json` (the App ID in all three places it appears,
   the origin, icons), zip it with a 192×192 `color.png` and a 32×32 transparent
   `outline.png`, and upload it in Teams. The tenant's custom-app-upload policy
   has to allow that — an admin toggle, not a licence. **Raise `version` when
   the manifest changes**, which is how Teams tells a new package from the
   installed one, and reinstall: Microsoft says a changed app configuration is
   not picked up otherwise
   (<https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload>),
   and warns that uploading a message extension again can leave two instances
   of it, so remove the old one first.
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
