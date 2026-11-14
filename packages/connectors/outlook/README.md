# @cockpit/connector-outlook

Messages a person flags for follow-up in a Microsoft 365 mailbox, or categorises
`Cockpit`, arrive in Cockpit as Tasks. Built on the connector SDK alone
("Build Outlook as a connector package on the SDK, unregistered", issue 1046)
and registered wherever the Microsoft client is set ("Connect Outlook from
Settings, wherever the Microsoft client is set", issue 1048). Done, Dismiss
and reopening a Task put the mark back on its message or take it off ("Take the
flag or category off in Outlook when its task is done in Cockpit", issue 1047).

## The quirks, which is what this file is for

- **One mark is followed per connection, chosen on connecting** (`choice` in the
  manifest: `flag`, offered to start, or `category`). The flag counts while it is
  `flagged`; a completed flag (`complete`) is no mark. The category is the
  fixed name `Cockpit`, and Outlook compares category names without regard to
  case, so `cockpit` counts. Unlike Gmail's label, **a mailbox needs no
  category called Cockpit in its list**: Outlook accepts the name on a message
  either way, so this never fails for a missing one.
- **Immutable ids, always.** Every request sends `Prefer: IdType="ImmutableId"`.
  Graph's default ids change when a message moves folder, which would make an
  archived message look like a new one and close the old Item. With immutable
  ids a message keeps its Item through any move.
- **No change feed is used; every run lists.** The run lists the ids of every
  message carrying the mark (`/me/messages` with `$filter` on the flag or
  category, `$select=id,parentFolderId,flag,categories`, 100 a page) and diffs
  them against the previous listing kept in the connector's state (`seen`). Only
  ids not seen are read in full and offered with `emitItem`; the host answers
  `already-known` for one it filed before, which is reported `reopened` (a
  message marked again after its Item closed). Rejected: emitting every marked
  message each run (hundreds of bodies every five minutes), delta query (per
  folder, so calls grow with the folders) and change notifications
  (subscriptions to renew, and a sweep anyway). The cost is state that grows
  with the number of marks: hundreds of short ids.
- **The filter narrows, the connector decides.** `/me/messages` spans every
  folder, Deleted Items included, and a deleted message keeps its flag and
  categories. The listing selects `parentFolderId` and leaves out anything in
  the folder named by `mailFolders/deleteditems` (the well-known name, one call
  a run), and the marks are checked on what comes back as well as in the
  `$filter`. A message read in full is checked again, since it may have been
  unmarked or deleted since the listing.
- **The listing is reported complete only when every page was read**, under the
  run's choice, after the new messages were emitted; the host closes the open
  Items brought in under that choice that it does not name. A listing that stops
  between pages (a budget spent, a `429`, a `503`) reports nothing and keeps
  nothing, since a short list would close Items that are still marked. The
  next-page link (`@odata.nextLink`) is followed only if it names the origin the
  token is for.
- **The previous listing is kept only after the emits succeeded.** A run that
  throws in the middle (a store that is down) keeps nothing, so the next run
  reads the same new ids and finds them known. A run stopped by the budget or
  by Microsoft holding the mailbox back keeps what it emitted: `seen` then holds
  the listing minus the messages it did not get to, which are read first next
  run, and none twice.
- **A message's categories are its Item's names** (`names` in the manifest),
  `Cockpit` left out while the connection follows the category, since it is the
  mark. They go with the message when it is emitted, and a message already in
  is reported again (`reportNames`) whenever the categories its listing row
  carries differ from those last reported, which `names` in the state keeps per
  id: the listing already selects `categories`, so this costs no Graph call. A
  message kept from before has none kept and is reported at its next listing.
  Each report is a round trip to the host, so a run makes at most
  `NAMES_REPORTED_PER_RUN` and leaves the rest to the next, which it asks for
  soon.
- **A changed choice starts the diff over.** `seen` is kept with the choice it
  was made under; a run whose choice differs lists under the new mark, reads
  everything carrying it and keeps the new choice.
- **A run has a call budget, and it is a parameter** (`callsPerRun`): the
  generic host's limit on calls out is measured when the connector is registered
  and the number given then. The refresh of an access token, the Deleted Items
  lookup, each listing page and each message read are spent from it. A run that
  reaches it answers `{ moreToDo: true }`. A listing larger than a budget can
  list would never finish: with 100 to a page that is thousands of marks.
- **Microsoft rotates refresh tokens.** Every refresh answer carries a new
  refresh token, and it is handed back through `setCredentials`, with the new
  access token and an absolute `expires_at`, **before** the new token is used.
  If the host does not keep it, the old one may no longer be honoured, so the
  connection fails "connect again" rather than holding a token nobody kept. A
  credential never refreshed here has no known expiry (the token response says
  `expires_in`, not since when) and is refreshed before first use. A `401` from
  Graph on a token that looked valid is refreshed once; a second `401` is the
  sign-in's.
- **A refresh refused with `400` or `401` is the sign-in no longer accepted**
  (`invalid_grant`), except `AADSTS65001` and `AADSTS90094` (consent missing,
  administrator consent required), which mean the organisation withdrew what it
  approved for Cockpit and say so. A `5xx` on refresh is Microsoft not answering
  this time and ends the run without failing the connection.
- **`408`, `429` and `5xx` from Graph end the run quietly**, logged, so the
  Connections window does not say "Failing" for five minutes over a blip. Any
  other refusal (no Exchange Online mailbox, a permission an administrator took
  away) fails the connection with the status, since asking again will not change
  it. `Retry-After` is not read: the next run is five minutes away.
- **Work and school accounts only.** The sign-in uses the multi-tenant
  endpoint, where a personal account (Outlook.com, Hotmail) signs in too and
  carries the fixed consumer tenant `9188040d-6c67-4c5b-b112-36a304b66dad`. It
  is refused with its own sentence. The account is keyed on tenant and object id
  (`tid`, `oid`); a token naming either missing names nobody.
- **`Mail.ReadWrite` is asked for, whole.** Delegated, with `offline_access`,
  on the same multi-tenant Entra application Teams connections use
  (`MS_CLIENT_ID`, `MS_CLIENT_SECRET`), so Teams connections are never asked
  again. A grant without it (an administrator can withhold it) is refused with
  its own sentence. The granted scope is read named bare or by its resource
  (`https://graph.microsoft.com/Mail.ReadWrite`). Microsoft offers nothing
  narrower that can set a flag or a category, so touching only the mark is
  Cockpit's rule, not Microsoft's.
- **No `revoke`.** Microsoft offers no revoke of one application's grant, and
  the only call that ends a person's tokens signs them out everywhere.
  Disconnecting forgets the credential; the person removes Cockpit at Microsoft
  if they want the grant gone.
- **Text.** The body is asked for as text (`Prefer: outlook.body-content-type="text"`)
  and, where Graph answers HTML anyway, has its tags taken out. A title and a
  sender are cut to 200 characters (the host's cap, restated here because a
  connector package may import nothing but the SDK), the text to 60,000. A
  message with no subject is titled `(no subject)`; with no text, its title
  stands in. The sender is the name in From, else the address, else none. The
  link is `webLink`, which opens the message in Outlook on the web.
- **Open state is mirrored, one field at a time** (`mirrorsOpenState`), and the
  host pushes it before the run lists, so the listing agrees with what was
  pushed. Following the flag, the flag alone is `PATCH`ed to `complete` or
  `flagged`, unread first: setting it to what it is changes nothing. Following
  the category, the list is read (`$select=categories`) and written back whole,
  `Cockpit` added or taken off in whatever case it was written and every other
  category kept, **conditional on the version read**: `If-Match` names the
  message's `@odata.etag`, and a write against a version Graph has moved past is
  refused with `412` (`409` and `ErrorIrresolvableConflict`, Exchange's word
  for the same, is read alike). A refused write is read again and retried, three
  attempts a run, then handed back next run. A list already as wanted is not
  written; one Graph gives no version for is never written unconditionally, and
  waits. A flag write answered `409`, a save of the message at the same moment,
  waits for the next run. A `404` is a message gone, and confirmed. `408`, `429` and `5xx` leave
  that change and every one after it for the next run; any other refusal (`403`,
  `400`) is given up on, so one message cannot hold up the rest. A `401` is
  refreshed once. The writes spend the run's `callsPerRun` before the listing does.

## Following a conversation ("Outlook follows the flagged conversation as Gmail does", issue 1707)

A connection following the flag makes one Item per **conversation**, keyed
`conversation:<conversationId>`, and the Item follows it, as a Gmail starred
conversation does. An Item made of one message before is keyed by the message's
id (no prefix), stays as it was, never follows, and is still pushed per message;
a message flagged again after its old Item closed makes a conversation Item.
Following the category is per message, as before.

- **The flagged listing reads each message's `conversationId`.** A flagged
  message the run has not read, in a conversation no open Item follows
  (`followedConversations`), is read in full and its conversation read whole
  (`messages?$filter=conversationId eq '…'`, drafts and Deleted Items left out),
  then emitted with where the conversation stands: the latest message (yours as
  for a turn, below), the count, the first message's time, who it is with, and
  whether anyone but you and the alias is a sender, To or Cc of any message in
  it (`othersOnIt`). The
  flagged message gives the title, text and sender. The host answering
  `already-known` is reported reopened, which is how flagging again after Done
  reopens the same Item. A message in a conversation already followed costs no
  call. The complete listing names `conversation:<id>` for such messages, so an
  Item closes when no message of its conversation is flagged.
- **A turn is any message received since the last run**, one read of the whole
  mailbox, not per conversation: `GET /me/messages?$filter=receivedDateTime ge T&$orderby=receivedDateTime`
  with `$select` of the id, conversation, folder, sender, To, Cc, time and
  `bodyPreview`, cut where quoted earlier mail starts (an underscore line,
  `From:`/`Van:` then `Sent:`/`Verzonden:`, `On … wrote:`/`Op … schreef …:`), and
  its `webLink`, which Open then goes to. Each message in a followed conversation is reported once the
  host asks (`reportTurn`; it changes nothing for one already reported). **Yours
  is a message in Sent Items** (the folder id from `mailFolders/sentitems`), so
  a send-as alias still counts, **or one sent from an address you send from or
  from your Cockpit alias**, wherever it is filed, so the alias's copy of a mail
  you sent, delivered to your Inbox, is yours too ("Outlook capture: a mail you
  Cc to your Cockpit alias arrives To do…", issue 1760). An address you
  send from is the sender of any message seen in Sent Items, compared without
  case; a run keeps the ones it has seen in its state (`sendsFrom`, at most 20),
  since the alias's copy and its Sent Items copy need not be in one read. Each
  turn also says whether anyone else is on it: a sender, To or Cc that is not
  you or the alias (`othersOnIt`). Bcc is never on a copy received. Drafts and Deleted Items
  are not turns. Nothing is read while no Item follows a conversation. A read
  cut short by the call budget keeps the time of the last message reported and
  answers that there is more to do; a complete one restarts five minutes
  before the run began, so a message stamped late is still seen (the host
  ignores a repeat).
- **Why `receivedDateTime`, and what is not proved.** Graph lists "the messages
  in the signed-in user's mailbox (including the Deleted Items and Clutter
  folders)" in one read (https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0),
  so Sent Items are included, and `$orderby` must name a property that is also in
  `$filter`, first. `createdDateTime` is documented as when the message was
  created (https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0),
  which for a reply is when its draft was started, so a send long after would
  fall behind the cursor; `receivedDateTime` is when it arrived, and Exchange
  stamps a sent message with the time it was sent. Graph does not document the
  last point; the contract test settles it against a real mailbox.
- **Done completes the flag on every flagged message of the conversation**
  (`messages?$filter=conversationId eq '…'&$select=id,flag`, then one `PATCH`
  each, in Deleted Items too), confirmed only when none is left; a conversation
  with more messages than the run's calls reach continues next run. A `403` or
  `400` gives it up like any message. Reopened in Cockpit, it is confirmed while
  a message in it is still flagged and otherwise given up, so the host stops
  following: flagging every message again would flag mail nobody chose.
- **Names** of a conversation Item are the union of the categories of its
  flagged messages, reported when they change.

## Drafts Email… makes ("Email… makes an Outlook draft the Item then follows", issue 1709)

*Email…* and *Reply…* are `makeDraft`, on demand while a person waits, for a
connection following the flag only (`startsConversations`), the one whose check
reads turns. Under the Mail.ReadWrite grant the connection already holds:

- **A new conversation's draft** is `POST /me/messages` with the Item's title
  as subject (one line, at most 200 characters), an empty plain-text body and no
  recipient (https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0).
- **A reply** is `POST /me/messages/{id}/createReply` on the conversation's
  newest message that is not a draft and not in Deleted Items, so Graph
  addresses it and puts it in the conversation
  (https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0).
  Two reads come first: the two folder ids, and the conversation.
- **The draft's `webLink`** opens it in Outlook on the web; it is the link for
  the draft and, once sent, for the conversation. Immutable ids are asked for as
  everywhere, so the draft keeps its id while it is edited and sent.
- **At most eight calls**, a refresh included. Never retried: a draft made
  twice is two drafts.
- **A check** reads each draft the host still waits on once, after the turns of
  the run (`GET /me/messages/{id}?$select=id,isDraft,parentFolderId`). Still a
  draft outside Deleted Items, it changes nothing. Otherwise, sent (a message
  now, or an id Graph no longer knows) or deleted (moved to Deleted Items), the
  conversation is read: a message in Sent Items after the draft's `after` is
  your turn, reported here since the read of received mail may never show it
  (sent while the Item was done, or before the cursor); none, and the draft is
  reported gone.
- **Reply… with a draft already waited on** asks first what became of it, the
  same way (`findDraft`): still a draft outside Deleted Items, its `webLink` is
  the answer and nothing is made; sent (a message in Sent Items in its
  conversation after `after`), the host is told so and makes nothing; otherwise
  a new one is made ("Conversation follow-up: Open, previews, drafts and Check now misbehave on real Gmail and Outlook mailboxes", issue 1720). At most seven calls: a refresh, the draft, the two
  folders and a page or two of the conversation.
- **A draft Claude writes** ("Mail follow-up: Email… and Reply… in Outlook make
  an empty draft: have Claude write it", issue 1731) is made with the body the
  Worker hands over. A new draft carries it as its plain-text `body`. `createReply`
  takes no request body in Graph's documentation, so a reply is made as above and
  its `body` is then updated with `PATCH /me/messages/{id}`, which Graph allows
  only while `isDraft` is true
  (https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0):
  the words go above the email Outlook quotes in the draft, as HTML
  (`<div>` a line, escaped) where the draft is HTML, else as text. **A refused
  update leaves the empty reply draft in the mailbox**, which the Worker does not
  know of, so the person is told the draft was not made. Still eight calls.
- **The conversation read for a reply** (`readConversationForReply`): the
  conversation is listed with the light turn fields as a check lists it, the
  newest ten kept, and each read once for `uniqueBody`, "the part of the body of
  the message that is unique to the current message", not returned by default
  (https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0),
  with `Prefer: outlook.body-content-type="text"`. HTML that comes back anyway is
  turned to text, and a quoted earlier email that is still in it is cut as the
  excerpt cuts it. The ten reads run together; a message with no `uniqueBody` is
  told by its preview. At most twenty calls.
- **Claude's draft written again** ("Mail follow-up: a Claude draft looks like
  any other and cannot be redone: say Claude drafted it, and redo it while you
  have not edited it", issue 1732). The look (`findDraft` with `{ text: true }`)
  reads the draft once with `uniqueBody` and `hasAttachments` added, as text
  (https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0):
  its own words above what it quotes, whole, or none where a file is attached.
  `rewriteDraft` reads its `body` as stored and replaces only the words at its
  top, compared spacing and markup aside, keeping the gap and the quoted email
  byte for byte, with a `PATCH` conditional on the version read
  (https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0).
  Words not found where they go, an image among them (which `hasAttachments`
  leaves out), or a save in between (412), is `changed`, and nothing is
  written. Three calls.

## Sent mail Follow a sent email… lists ("Follow a sent email… in Capture", issue 1710)

`listRecentSent` is on demand while a person waits and changes nothing: one
`GET /me/mailFolders/sentitems/messages?$top=30&$orderby=sentDateTime desc` with
`$select=id,conversationId,subject,toRecipients,sentDateTime,bodyPreview,webLink,isDraft`
(https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).
Three times the limit is asked for and the newest message of each conversation kept. A draft or a message with no conversation or time is not listed. The link is the
message's `webLink`, which opens it in Outlook on the web.



## Not yet known

- **Whether a draft made, opened and sent in real Outlook behaves as the
  stand-in does**: `webLink` opening a draft for writing (rather than a read
  view), its id staying the same through editing and sending (the check copes
  with either), `createReply` on a message of your own addressing it to whom it
  went, and how long the calls take ("Measure Email… and Follow a sent email…
  on test mailboxes", issue 1704, was skipped). The draft shapes come from
  Graph's documentation; the contract test has no case for them.
- **What `uniqueBody` holds for a reply draft, and how Outlook rewraps the
  words Cockpit put in it.** The documentation says only that it is the part
  unique to the message; the stand-ins take it as everything above the quoted
  email. Where real Outlook answers more, every Claude reply draft reads as
  edited and is opened as yours, never overwritten (issue 1732).
- **Whether Exchange gives a sent message a `receivedDateTime` of when it was
  sent**, and whether `conversationId` accepts `eq` in a filter, as written
  above. The contract test (`reads the mail received since…`) settles both; it
  did not run when this was written.

- **Whether `tests/contract/` still passes.** It reaches a dedicated Microsoft
  365 mailbox and skips without the three `OUTLOOK_CONTRACT_*` secrets, so it
  did not run when this was written. The recorded payloads in
  `tests/graph-payloads.ts` are therefore Graph's documented shapes, not
  captured answers, until it does.
- **Whether Graph combines the filter with the fields selected without an
  `InefficientFilter` error, and whether `categories/any(c:c eq 'Cockpit')`
  matches without regard to case.** The connector does not depend on either: it
  checks the marks itself. The contract test is where this is settled.
- **Whether Graph honours `If-Match` on a message `PATCH`**, rather than
  ignoring it, and answers `412` or `409`. Graph documents the `412` for drive
  and list items and returns `@odata.etag` on a message, but says nothing of a
  conditional message write; were it ignored, a category changed between the
  read and the write would be lost. The contract test's stale-version case is
  where this is settled.
