# @cockpit/connector-outlook

Messages a person flags for follow-up in a Microsoft 365 mailbox, or categorises
`Cockpit`, arrive in Cockpit as Tasks. Built on the connector SDK alone
("Build Outlook as a connector package on the SDK, unregistered", issue 1046),
and **not registered**: nothing in the application offers it yet. It only reads
the mailbox; closing and reopening Items in the mailbox is a later slice.

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

## Not yet known

- **Whether `tests/contract/` still passes.** It reaches a dedicated Microsoft
  365 mailbox and skips without the three `OUTLOOK_CONTRACT_*` secrets, so it
  did not run when this was written. The recorded payloads in
  `tests/graph-payloads.ts` are therefore Graph's documented shapes, not
  captured answers, until it does.
- **Whether Graph combines the filter with the fields selected without an
  `InefficientFilter` error, and whether `categories/any(c:c eq 'Cockpit')`
  matches without regard to case.** The connector does not depend on either: it
  checks the marks itself. The contract test is where this is settled.
- **The call budget.** Measured when the connector is registered.
