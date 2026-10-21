# @cockpit/connector-gmail

Conversations a person labels `Cockpit`, or emails they star, arrive in Cockpit
as Tasks. A label or star taken off closes the Task, put back reopens it, and
closing or reopening the Task in Cockpit does the same to the label or star.
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
- **A star belongs to one email, so by star every email is an Item of its own**
  ("Bring in each email you star in Gmail as its own Item", issue 1398): two
  starred emails in one conversation are two Items, each with its own subject,
  plain text, sender, time and link (`#all/<message id>`), and with only its own
  user labels as names. Gmail gives a conversation the id of its first email, so
  an email's source id is `message:<id>`, a namespace no conversation id can
  take; a bare email id would name the conversation's Item. By label an Item is
  still a conversation.
- **Conversation Items from before only close.** An Item a connection following
  the star made of a whole conversation keeps its bare conversation id. It is
  marked done once no email in the conversation is starred, and is never
  reopened: Done in Cockpit still unstars the whole conversation (`threads.modify`),
  but reopening one is given up on, since starring the conversation stars every
  email in it and each would come in as a new Item. An email starred in its
  conversation afterwards comes in beside it as its own Item.
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
  (`messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved`) names the
  conversations that *gained* the mark, and the ones whose mark *may* have come
  off or gone back (removed or added again, a marked message binned, unbinned or
  deleted for good). Only a read of the conversation says which. A mark added
  and taken off again within a page is nothing new. **By star the entries are
  read per email** (they carry the email's id and its conversation's), grouped
  by conversation: one `threads.get` per conversation changed answers for every
  email of it that changed and for the conversation Item from before, so the
  call budget is spent per conversation changed however many of its emails did.
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
  message (by star, on the Item's own email only), resolved from the list the
  label choice reads anyway for the mark.
  Gmail's own labels (`type` `system`, including `CATEGORY_*`) and the followed
  `Cockpit` label are left out; by star `Cockpit` is a label like any other.
  They go with the item when emitted, and are reported again (`reportNames`)
  for a conversation whose history shows a label other than the mark and
  Gmail's own added or taken off (an email by star, and a conversation Item
  from before still open). That read is `format=minimal`, one call per
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
  which by star group its emails; the saved state's `version` says which
  meaning a saved place has, and one saved under another is read again from its
  page's start (everything emitted is idempotent).
- **Open states are pushed before anything is read** (`mirrorOpenState`), so
  what the history then reports of them agrees with the Items and changes
  nothing. The change adds or removes the one mark and touches no other label:
  `threads.modify` on the whole conversation by label, `messages.modify` on the
  one email by star (a conversation Item from before is closed with
  `threads.modify` and never reopened). A conversation or email that is gone
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

## Not yet known

- **Whether Gmail opens a link to one email (`#all/<message id>`) at that email
  in conversation view as well as with it off.** The Item links the email by
  its own id; only a real mailbox shows how each view treats it.
- **Whether `tests/contract/` still passes.** It reaches a dedicated mailbox and
  skips without the three `GMAIL_CONTRACT_*` secrets, so it did not run when this
  was written; it carries over the core's suite, plus one case listing emails
  (`messages.list`), which has never run against a real mailbox either.
