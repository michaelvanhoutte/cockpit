# @cockpit/connector-gmail

Conversations a person labels `Cockpit`, or stars, arrive in Cockpit as Tasks. A
label or star taken off closes the Task, put back reopens it, and closing or
reopening the Task in Cockpit does the same to the label or star. Built on the
connector SDK alone ("Build Gmail as a connector package on the SDK,
unregistered", issue 943). **Not registered**: the application does not list it
yet, so a running Cockpit is unchanged ("Switch Gmail onto the generic host, and
take it out of the core", issue 944).

## The quirks, which is what this file is for

- **One mark is followed per connection, chosen on connecting** (`choice` in the
  manifest: `label` or `star`). The label is the mailbox's own label called
  `Cockpit` (names are unique in Gmail whatever their case, so `cockpit` is the
  same label), and is not created here: a mailbox without one fails the
  connection with a sentence saying so, unless it follows the star. The star is
  Gmail's system label `STARRED`, which is what Outlook's flag for follow-up sets.
- **Labels belong to messages, not conversations.** Labelling a conversation
  labels the messages it holds then, and a reply after it arrives without the
  label. So the message read for an Item is the most recent one *carrying the
  mark* (the last message where none does), and a reply never makes a
  conversation look unmarked or new.
- **A marked message in the bin or spam keeps its labels** and no longer counts
  as marked, as Gmail's own listing leaves it out. A conversation counts as
  marked while some message carries the mark outside the bin and spam.
- **A star counts only from the moment of connecting**, because Gmail says a
  conversation is starred and never when. So a connection following the star
  records a position and brings in only what its history says was starred after
  it. Its complete listing of starred conversations **only closes** (it reports
  them as seen and files nothing), and reopens come from the history.
- **History is read, not listed.** `users.history.list` restricted to the mark
  (`messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved`) names the
  conversations that *gained* the mark, and the ones whose mark *may* have come
  off or gone back (removed or added again, a marked message binned, unbinned or
  deleted for good). Only a read of the conversation says which. A mark added
  and taken off again within a page is nothing new.
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
- **A run has a call budget** (`CALLS_PER_RUN`, 40, the figure Gmail had in its
  own alarm; issue 944 sets it from a measurement on the generic host). The
  refresh of an access token is spent from it too, and so are the pushes of
  waiting open states, which share it with the read after them. A run that
  reaches it saves where it was and answers `{ moreToDo: true }`. **Where it was
  includes the place inside a page** (`history.done`, `listing.done`): a page
  with more conversations than a run can read would otherwise start over every
  time and never end.
- **Open states are pushed before anything is read** (`mirrorOpenState`), so
  what the history then reports of them agrees with the Items and changes
  nothing. The change is `threads.modify` on the whole conversation, adding or
  removing the one mark and touching no other label. A conversation that is gone
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
  text, its subject stands in. Text is the plain part, else the HTML part with
  its tags taken out; a body that cannot be decoded is brought in under its
  subject rather than stopping everything after it.

## Not yet known

- **How many calls a run really makes on the generic host.** The budget is
  inherited, not measured (issue 944).
- **Whether `tests/contract/` still passes.** It reaches a dedicated mailbox and
  skips without the three `GMAIL_CONTRACT_*` secrets, so it did not run when this
  was written; it carries over the core's suite unchanged.
