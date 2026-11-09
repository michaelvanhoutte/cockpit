# @cockpit/connector-gmail

Conversations a person labels `Cockpit`, or stars an email of, arrive in Cockpit
as Tasks. A label or star taken off closes the Task, put back reopens it, and
closing or reopening the Task in Cockpit does the same to the label or star. A
starred conversation's Task follows it: every later message is reported as a
turn, and the host sets the status by who wrote it.
Built on the
connector SDK alone ("Build Gmail as a connector package on the SDK,
unregistered", issue 943), and registered wherever `GMAIL_CLIENT_ID` and
`GMAIL_CLIENT_SECRET` are set ("Switch Gmail onto the generic host, and take it
out of the core", issue 944).

## The quirks, which is what this file is for

- **One mark is followed per connection, chosen on connecting** (`choice` in the
  manifest: `label` or `star`). The label is the mailbox's own label called
  `Cockpit` (names are unique in Gmail whatever their case, so `cockpit` is the
  same label), and is not created here: a mailbox without one fails the
  connection with a sentence saying so, unless it follows the star. The star is
  Gmail's system label `STARRED`, which is what Outlook's flag for follow-up sets.
- **Labels belong to messages, not conversations.** Labelling a conversation
  labels the messages it holds then, and a reply after it arrives without the
  label. So the message read for an Item by label is the most recent one
  *carrying the mark* (the last message where none does), and a reply never
  makes a conversation look unmarked or new.
- **A star belongs to one email, but by star the Item is its conversation**
  ("A Gmail starred conversation is one Item whose status follows who wrote
  last", issue 1705): the first email starred in a conversation brings it in
  under the conversation's bare id, titled with that email's subject and
  following the conversation (`SourceItem.conversation`, read from the same
  `threads.get`); a second one starred adds nothing. A label Item for the same
  thread is the same Item. The conversation is marked done once no email in it
  is starred; Done in Cockpit unstars the whole conversation (`threads.modify`),
  and reopening one in Cockpit while no email in it is starred is given up on
  (a `threads.get` says which), since starring the whole conversation stars
  emails nobody chose; the host then has the Item stop following it.
- **A reply arrives without the star, so by star the history is read unfiltered**
  for every message added to a conversation an open Item follows, which the
  host names each run (`followedConversations`). Each is read with
  `messages.get` (`format=full`) and reported as a turn: **yours where Gmail
  labels it `SENT`**, whatever address it was sent as, else theirs, named by its
  From, with the message's own link (`#all/<message id>`), which Open then goes
  to, and an excerpt cut where quoted earlier mail starts (an underscore line,
  `From:`/`Van:` then `Sent:`/`Verzonden:`, `On … wrote:`/`Op … schreef …:`, a `>` line).
  A draft (`DRAFT`), and a message in the bin or spam, is no turn. Turns
  are read before the star's changes on the same page, and the page's turns
  already reported are kept in the state by message id (`history.turns`), so a
  run that stops mid-page reports none twice. The star's own changes are read
  from the same pages, keeping only records whose message carries or moves the
  star, or that are in a followed conversation.
- **Items from before conversations were followed stay as they were.** An Item
  a release before made of one starred email keeps its source id
  `message:<id>` (a namespace no conversation id can take): it is marked done
  when that email's star comes off or it is binned, Done in Cockpit unstars that
  email alone (`messages.modify`), it never follows, and starring its
  conversation again brings the conversation in beside it. Read unfiltered, a
  deletion says no labels, so such an email deleted for good is seen only by
  the next complete listing.
- **A marked message in the bin or spam keeps its labels** and no longer counts
  as marked, as Gmail's own listing leaves it out. A conversation counts as
  marked while some message carries the mark outside the bin and spam.
- **A star counts only from the moment of connecting**, because Gmail says an
  email is starred and never when. So a connection following the star records a
  position and brings in only what its history says was starred after it. Its
  complete listing of starred emails (`messages.list`, ids only, 500 a page)
  **only closes**: it reports each starred email's Item id and its
  conversation's, so both kinds of Item stay open while they should, and files
  nothing. Reopens come from the history. It lists about as many ids as there
  are starred emails, and is kept in the state as it goes: a mailbox with tens
  of thousands spends several runs on connecting.
- **History is read, not listed.** `users.history.list` restricted to the mark
  (by star, unfiltered, as above; `messageAdded`, `messageDeleted`,
  `labelAdded`, `labelRemoved`) names the
  conversations that *gained* the mark, and the ones whose mark *may* have come
  off or gone back (removed or added again, a marked message binned, unbinned or
  deleted for good). Only a read of the conversation says which. A mark added
  and taken off again within a page is nothing new. **By star the entries are
  read per email** (they carry the email's id and its conversation's), grouped
  by conversation: one `threads.get` per conversation changed answers for every
  email of it that changed, so the call budget is spent per conversation changed
  however many of its emails did, plus one `messages.get` per turn.
- **A history position lapses after about a week**, and Gmail answers `404` for
  it. That is the signal to start over with a complete listing from a fresh
  position. The position is saved only once a page's conversations are all done.
- **A complete listing records the position first**, so whatever is marked while
  it runs is after that position and the history reads it. It lists a page at a
  time (50 conversations by label, 500 by star: the star's page reads nothing
  but ids), and saves where it is. **A reply moves a conversation to the front
  of the listing**, past a reader part-way down it, so the front page is read
  once more at the end and its ids joined to the listing before it is reported;
  otherwise such a conversation would be closed as unseen.
- **The host cannot be asked whether it knows a conversation**, so every marked
  conversation a listing sees is read in full and offered with `emitItem`; the
  host answers `already-known`, and the connector then says `reopened`, which
  changes nothing for an Item that is open and loses to a change of Cockpit's
  that is still waiting for Gmail. A complete listing therefore costs a read per
  marked conversation, and runs on connecting, on a lapsed position and when
  the choice changes: not on a schedule.
- **A conversation's user labels are its Item's names** (`names` in the
  manifest; "File Gmail conversations on the Panel named after their label",
  issue 1148): the labels of type `user` in `labels.list`, on any
  message (an Item made of one email before, on that email only), resolved from the list the
  label choice reads anyway for the mark.
  Gmail's own labels (`type` `system`, including `CATEGORY_*`) and the followed
  `Cockpit` label are left out; by star `Cockpit` is a label like any other.
  They go with the item when emitted, and are reported again (`reportNames`)
  for a conversation whose history shows a label other than the mark and
  Gmail's own added or taken off (by star, on a message carrying the star or
  in a followed conversation). That read is `format=minimal`, one call per
  conversation, spent from the run's budget (so at most about 40 reports a run,
  and no separate cap as Outlook has: every report here follows a Gmail call).
  By label the list costs nothing; by star it is one extra `labels` call, the
  first time a run has names to say. **A rename leaves no history**, so a
  renamed label is reported by its new name when the conversation's labels next
  change or it is read in full; and **the history is read by the mark**, so a
  label put on a message that lacks it, such as a reply, is seen then too. No
  names are kept in the state: the host reports nothing twice.
- **A run has a call budget** (`CALLS_PER_RUN`, 40, measured on the generic host
  against the free plan's 50 calls out per invocation; issue 944). The
  refresh of an access token is spent from it too, and so are the pushes of
  waiting open states, which share it with the read after them. A run that
  reaches it saves where it was and answers `{ moreToDo: true }`. **Where it was
  includes the place inside a page** (`history.done`, `listing.done`): a page
  with more conversations than a run can read would otherwise start over every
  time and never end. `history.done` counts the conversations of a page done,
  which by star group its emails, and `history.turns` names its turns
  reported; the saved state's `version` says which meaning a saved place has,
  and one saved under another is read again from its page's start, or by star
  from the position, since a page token asked for the filtered read (everything
  emitted is idempotent).
- **Open states are pushed before anything is read** (`mirrorOpenState`), so
  what the history then reports of them agrees with the Items and changes
  nothing. The change adds or removes the one mark and touches no other label:
  `threads.modify` on the whole conversation, by label or by star (a starred
  conversation is closed that way and never reopened), and `messages.modify` on
  the one email of an Item made of one email before. A conversation or email that is gone
  (`404`) has nothing to mark and counts as confirmed. `408`, `429`, any `5xx`
  and a `403` for a rate limit (`rateLimitExceeded`, `userRateLimitExceeded`,
  `dailyLimitExceeded`, `quotaExceeded`) mean Gmail is holding the mailbox back:
  the change is neither confirmed nor given up, and the rest wait for the next
  run. Any other refusal is for good and is given up on, so one conversation
  Gmail will not relabel cannot hold up the others.
- **Google issues a refresh token only when asked.** The sign-in asks with
  `access_type=offline` and `prompt=select_account consent`: without `consent`
  a mailbox connected before, disconnected elsewhere and connected again comes
  back with none. A grant without a refresh token, or with the `gmail.modify`
  permission unticked on the consent screen (each permission can be), is refused
  with a sentence saying which. Google offers nothing narrower than `gmail.modify`
  that can remove a label, so touching only the mark followed is Cockpit's rule,
  not Google's.
- **Access tokens last an hour and the refresh token is not rotated.** The
  credential is only the token response as Google issued it, which says
  `expires_in` and not since when, so a credential never refreshed here has no
  known expiry and is refreshed before it is first used. Each refresh hands back
  the whole credential with an absolute `expires_at` added, through
  `setCredentials`, **before** the new token is used: a run that stops after a
  refresh leaves the old credential or the new one, never neither. A `401` from
  Gmail on a token that looked valid is refreshed once; a second `401`, or a
  refresh answered `400` or `401` (`invalid_grant`, `invalid_client`), is Google
  no longer accepting the sign-in and fails the connection with that reason. Any
  other refresh failure is Google not answering this time.
- **Disconnecting revokes the grant.** Google revokes the whole grant, not one
  token, which is why the host calls `revoke` only when no other Workspace holds
  the same mailbox. The endpoint is the one the issuer's discovery document
  names.
- **No stored Gmail credential is read.** Only the generic shape the generic
  sign-in seals: every connection made before this connector reconnects once.
- **A title and a sender are cut to 200 characters** (the host's cap, restated
  here because a connector package may import nothing but the SDK), and the text
  to 60,000. A conversation with no subject is titled `(no subject)`; with no
  text, its subject stands in (by star, the email's own). Text is the plain
  part, else the HTML part with its tags taken out; a body that cannot be
  decoded is brought in under its subject rather than stopping everything after
  it.

## LinkedIn message notifications

A starred LinkedIn message notification is followed as the LinkedIn
conversation it tells of, not as the email ("Follow the LinkedIn conversation
instead of the notification", issue 1711). The notification emails the tests
use are reconstructed, not captured (`tests/linkedin-notifications.ts` says
so); replace them with a captured one when there is one.

- **A notification is recognised by its sender's domain and its link.** From
  `linkedin.com` or a subdomain of it, with an address in its bodies that
  leads to `/messaging/thread/<id>/`, directly, through LinkedIn's `/comm/`
  prefix, or in the query of a LinkedIn redirect (looked into twice, never
  fetched). Any other LinkedIn email, a link to another host, a plain-http link
  or a thread id with odd characters is plain mail.
- **Only `https://www.linkedin.com/messaging/thread/<id>/` is kept**, built from
  the id, so the email's tracking token is never reported. The conversation is
  keyed `linkedin:<id>`, which no Gmail thread id can be; the web names the
  source *LinkedIn* by that prefix (`LINKEDIN_CONVERSATION_PREFIX`, shared).
- **Only their turns are seen**; the sender's name is read off *Name via
  LinkedIn*, and the excerpt is the text between the name and the *View
  message* (*Bekijk bericht*) button.
- **A later notification is found by sender, not by thread.** While an open Item
  follows a LinkedIn conversation, each page of history that added mail also
  asks `messages.list` for `from:messages-noreply@linkedin.com` (the newest
  100) and reads in full only the added messages that are among them, the one
  place the connector reads a message outside a followed Gmail conversation.
  With no LinkedIn conversation followed, that call is not made. A notification
  that is no longer among the newest 100 when its page is read, after a long
  backlog, is missed. The notification sender is a constant; if LinkedIn changes
  it, turns stop and the line goes stale.
- **A star on another notification of a followed conversation adds to its Item**
  and makes no second one.

## Drafts Email… makes

*Email…* and *Reply…* ("Email… makes a Gmail draft the Item then follows",
issue 1708) are `makeDraft`, on demand while a person waits, for a connection
following the star only (`startsConversations`), the one whose check reads
turns:

- **`users.drafts.create`** with a `raw` RFC 2822 message under the modify grant
  the connection holds: the Item's title as subject (an RFC 2047 encoded word
  outside ASCII), no To, an empty plain-text body; Gmail adds the From.
- **A reply** names the conversation's `threadId` and carries `In-Reply-To` and
  `References` for its latest message that is not a draft, behind *Re:* and that
  message's subject (or the newest one with a subject), as Gmail threads one; it
  is addressed as Gmail's Reply is, to the latest message's Reply-To or From, or
  to its To where it was yours. One metadata read of the conversation first.
- **At most four calls**: a refresh, the profile where no check saved the address
  yet, that read, and the draft. Never retried: a draft made twice is two drafts.
- **The link** opens the draft itself: `#drafts?compose=` with the code Gmail's
  own address bar shows for it, built from the conversation and draft ids. Gmail
  does not document the code; one real draft's decoded to
  `f:<conversation id in decimal>|msg-a:<draft id>+msg-a:<draft id>` in base64,
  then rewritten in Gmail's alphabet of consonants, and the link built from the
  API's ids opened that draft ("Conversation follow-up: Open, previews, drafts
  and Check now misbehave on real Gmail and Outlook mailboxes", issue 1720).
  Should Gmail change the code, the
  link opens a blank message over the Drafts folder. The conversation's link, until the draft
  is sent, names the message replied to, or the draft where it starts the
  conversation.
- **Reply… with a draft already waited on** asks first what became of it
  (`findDraft`), as the check below tells it: still there outside the bin, its
  link is the answer and nothing is made; sent (gone, with a message sent from
  the mailbox in its conversation since), the host is told so and makes nothing;
  otherwise, gone or labelled `TRASH`, a new one is made ("Conversation follow-up: Open, previews, drafts and Check now misbehave on real Gmail and Outlook mailboxes", issue 1720). At most four calls:
  a refresh, the draft, the profile where no check saved the address yet, and
  the conversation.
- **A check** reads a draft's conversation as any followed one: the draft sent,
  whether its message keeps its id (Draft off, Sent on) or comes back as a new
  one, is a turn of yours. Once the history is read to the end, each draft the
  host still waits on is asked for (`drafts.get`); gone, with no message sent
  from the mailbox in its conversation since, it is reported gone. A draft whose
  message carries `TRASH` counts as gone: Gmail keeps it until the bin is emptied.

## Sent mail Follow a sent email… lists ("Follow a sent email… in Capture", issue 1710)

`listRecentSent` is on demand while a person waits and changes nothing.

- **`users.messages.list` with `labelIds=SENT&maxResults=30`** (three times the
  limit) answers the ids of the newest sent emails, newest first, of which the
  newest of each conversation is kept (up to ten) (the bin and spam are left out as Gmail
  leaves them); **each is read once with `format=metadata`** and the `Subject` and
  `To` headers, which gives its conversation (`threadId`), time (`internalDate`)
  and `snippet`, HTML-escaped by Gmail and unescaped here. At most 14 calls: a
  refresh, the list, the mailbox's address where no check saved it, ten reads.
- A message that is a draft, in the bin, or has no conversation or time is not
  listed. A `To` header is shown as a person reads it: a name where there is one,
  else the address.
- The link names the email listed, not its conversation, as a followed one's does.



## Not yet known

- **Whether a draft made, opened and sent in real Gmail behaves as the stand-in
  does**: the draft's id
  staying the same while it is edited, and how long the call takes ("Measure
  Email… and Follow a sent email… on test mailboxes", issue 1704, was skipped).

- **Whether a real LinkedIn notification reads as the fixtures say**, and whether
  `messages.list` with `q=from:` finds it. Both are reconstructed from the
  format as publicly seen; the contract suite covers neither.

- **Whether Gmail opens a link to one email (`#all/<message id>`) at that email
  in conversation view as well as with it off.** The Item links the email by
  its own id; only a real mailbox shows how each view treats it.
- **Whether `tests/contract/` still passes.** It reaches a dedicated mailbox and
  skips without the three `GMAIL_CONTRACT_*` secrets, so it did not run when this
  was written; it carries over the core's suite, plus one case listing emails
  (`messages.list`), which has never run against a real mailbox either.
