# POC — Notion follow-up inbox

[docs/notion-integration-options.md](../../docs/notion-integration-options.md) picks **Option 5, Integration/Connection Webhooks plus the Notion API**, as Cockpit's Notion integration. That document is an argument on paper. This POC turns it into an experiment, the same way [poc/slack-realtime](../slack-realtime) did for Slack.

It answers five questions, on a **free** Notion plan:

1. Can I see all new actions **assigned to me** in a database?
2. Can I see all new **mentions of me in documents**?
3. Can I see all new **mentions of me in comments**?
4. Can I see all **replies to comments I created**?
5. For any of those, can I be told when the item is later **marked as handled** in Notion?

## The short answer

| | Signal | Available? | How |
|---|---|---|---|
| 1 | Assigned to me in a database | **Yes, directly** — mechanism not yet exercised | `POST /v1/data_sources/{id}/query` with `{property: "Assignee", people: {contains: "<your-user-id>"}}`. Requires a **people-type** property to exist |
| 2 | Mentions of me in a document | **Confirmed, by crawling** | No content search exists. Enumerate reachable pages, read their blocks **and their text properties**, match the `mention` token |
| 3 | Mentions of me in comments | **Confirmed, by crawling** | `GET /v1/comments?block_id=…`, one page or block at a time. Must probe **every block**, not just the page |
| 4 | Replies to my comments | **Yes, by reconstruction** — needs a second person to test | Group comments by `discussion_id`, take anything after your own comment by another author |
| 5 | Told when it is handled | **Partly** | Assignment: yes, cleanly. Document mention: no. Comment: only as an ambiguous disappearance |

All five are workable. But the shape of the answer is the finding, and it is not the shape the options document assumes.

**Nothing here is plan-gated.** The public API is available on the free plan, and so are integration webhooks. The paid feature the options document correctly rejects in Option 4 is the *automation* action called "Send webhook", which is a different thing from the integration webhooks in Option 5. Free-plan status does not block any of this. What it may affect is the per-workspace rate limit, which Notion scales by plan, and the sweep in signals 2–4 is exactly the thing that would hit it.

## Validation status — August 2026

Measured against a live **free** personal workspace, API version `2026-03-11`. Reach: 5 pages and 1 data source shared with the integration. 23 requests, no rate limiting.

**Two of the four signals are confirmed working. Two are not yet proven, both because the workspace lacks the thing they need rather than because the API lacks it.** The distinction matters, and the harness reports `SKIP` rather than `FAIL` precisely so it cannot be blurred.

| Signal | Result |
|---|---|
| 1 — assignments | **Untested.** The reachable database has only `Name` (title) and `Text` (rich_text). No people-type property exists, so nothing in this workspace *can* be assigned to anyone. Add a Person property and re-run. |
| 2 — document mentions | **Confirmed.** 3 references across 2 pages, matched on the `mention` token. |
| 3 — comment mentions | **Confirmed**, but only with `DEEP_COMMENTS=1`. See below — this was nearly a false negative. |
| 4 — replies | **Half-proven.** One discussion containing a comment of mine was found and reconstructed correctly; nobody had replied to it, so the reply path itself is still unexercised. Needs a second account. |
| 5 — handled | Unchanged from the documented analysis. Run `npm run handled` to measure it. |

Three things the run taught that the documentation did not, all of which changed the code:

**1. Mentions live in page *properties*, not only in blocks.** A database row that references you usually does so in its title or a notes column — and such a row frequently has **no blocks at all**. The first version of the crawler read only blocks, so it reported a confident zero on exactly the row that mentioned the user. Page properties are now scanned as part of signal 2, at no extra request cost, because `POST /v1/search` already returns page objects with their properties attached. Measured split on this workspace: 2 mentions in blocks, 1 in a property.

**2. The ordinary comment is a *block* comment, and a page-level query does not return it.** Selecting text and commenting — the normal way people comment in Notion — anchors the comment to a block. `GET /v1/comments?block_id=<page-id>` returned **nothing** for a page that visibly had a comment mentioning the user; the comment only appeared when every block was probed individually. This is the most dangerous finding in the run, because the failure mode is silent: a zero that looks like a measurement. `DEEP_COMMENTS` now defaults to **on** despite costing one request per block, on the grounds that a slow correct answer beats a fast wrong one.

**3. `display_name.resolved_name` is populated for human comments.** The documentation describes it as a custom name an integration sets, which suggested every comment author would need a separate `GET /v1/users` lookup. In practice the field came back filled in for an ordinary human comment, so the lookup is a fallback rather than a requirement. Keep the fallback — a field documented as optional can be absent — but do not build around needing it.

Confirmed as expected, with no surprises: the `POST /v1/search` title-only limit (searching the user's own name returned **0** of the 2 pages that mention them, which is the content-search gap demonstrated rather than asserted); page objects carrying a usable `url` (`https://app.notion.com/p/…`); comments carrying no permalink; the bot identity being distinct from the person identity.

### The finding that decides the sync architecture

**Commenting does not bump the page's `last_edited_time`.** Measured: a comment created at `2026-08-12T16:03` sat on a page whose `last_edited_time` was still `2026-08-10T18:13`, 2750 minutes earlier. N5 now checks this automatically on every run, by comparing each comment's `created_time` against its own page's `last_edited_time` — free, from data the crawl already holds. (A comment in the *same* minute proves nothing, because Notion timestamps are minute-granular. Only a strictly newer comment is decisive.)

The consequence splits the four signals in two, and it is not a latency argument:

| | Cheap catch-up? | Why |
|---|---|---|
| 1 assignments, 2 document mentions | **Yes** | These are page edits. Walk `POST /v1/search` sorted by `last_edited_time` descending, stop at your high-water mark. Cost is proportional to what changed, not to workspace size |
| 3 comment mentions, 4 replies | **No** | The page holding a brand-new comment looks untouched, so a timestamp-bounded sweep cannot see it. Search does not index comments either, so there is no cheap middle option — reconciling comments always costs the full block-level sweep |

So the argument for a push channel is not freshness, it is that **a missed comment event is expensive to recover from while a missed page edit is not**. Signals 1 and 2 self-heal on the next incremental sweep; signals 3 and 4 need a full block-level sweep to notice they were missed at all. Whatever detects comment events therefore has to be durable.

**Which is why the detector ended up being email, not webhooks.** See "Revision, August 2026" in [the options document](../../docs/notion-integration-options.md). Notion sends one email per event within ~2–3 minutes, and the tracking link in it decodes **offline** — base64 + zlib — to the page id, the **block** id, a machine-readable `email_subtype`, and a stable dedupe uuid. That block id is what makes the whole cost problem go away: the expensive part was never reading a comment, it was *finding* which block held it. Email hands that over directly, so steady state is 1–2 requests per change with no sweep at all.

It is also strictly more durable than a webhook, which is at-most-once and abandoned after ~24 hours of retries, and it needs no public HTTPS endpoint. Measured caveat: an email arrived for a page the integration could not read (`object_not_found`), so email triggers on more than the API can interpret. Awareness is wider than actionability.

**Cost, in the right units.** Steady state with webhooks is **1–2 requests per actual change**: the payload names the changed object, Cockpit fetches just that. The 3.6-requests-per-page sweep figure (≈1800 requests / ≈600s for a 500-page workspace) is the **backfill and full-reconciliation** cost — a cold start, or catching up after downtime — not a per-sync cost.

**Still unmeasured:** the assignment path (signal 1), the reply path (signal 4), the handled experiment, and the entire webhook leg — whether events arrive at all on a free plan, what the payloads contain, and whether resolving a comment emits anything.

## Why Notion is a harder shape than Slack

Worth stating plainly, because it changes the integration rather than merely complicating it.

**Slack let Cockpit ask.** One `assistant.search.context` call with `query: "<@U123>"` returned every mention, precisely, with a permalink attached. The signal had a query behind it.

**Notion has no such query.** Three things are missing, and each is confirmed absent from the API reference rather than merely undiscovered:

- **No inbox, notification or activity endpoint.** The thing you actually want — what Notion itself shows in its Inbox — has no API. Cockpit has to reconstruct it.
- **No content search.** `POST /v1/search` "Returns all pages or data_sources […] that have titles that include the `query` param." Titles. A mention of you buried in a paragraph is invisible to it. There is no mentions endpoint either.
- **No workspace-wide comment listing.** `GET /v1/comments` takes a single `block_id`. There is no "all comments involving me".

So signals 2, 3 and 4 are not searches. They are **sweeps**: enumerate everything the integration can reach, read it, and match locally. That turns a latency problem into a throughput problem, and it is why this POC measures request counts as carefully as it measures correctness.

And on top of that:

**Reach is a hard ceiling.** A Slack user token saw whatever the user saw. A Notion integration starts with access to **nothing** and sees only what has been explicitly shared with it. A mention on an unshared page is not an error — it simply is not in the results. This is the most likely cause of a run that comes back mysteriously empty, so N1 measures it before anything else.

**The token is not you.** The integration authenticates a *bot*, with its own user id. "Assigned to me" and "mentions me" have to match your **person** user id, which is a different value. The people filter even documents a `"me"` shorthand that looks like exactly what you want and resolves to the *authenticated* user — the bot — so it returns zero rows without erroring. N2 probes that trap deliberately.

## What it tests

| Probe | Question | Why it matters |
|---|---|---|
| **N0** | Is the token valid, and which capabilities does the integration have? | Notion's equivalent of Slack scopes. Comment reading and user reading are each load-bearing for two of the four signals. |
| **N0b** | Which user id is "me"? | The bot id is not yours. Everything downstream compares against this, so getting it wrong makes all three "involving me" signals silently return nothing. |
| **N1** | How much of the workspace can the integration see? | Reach caps every signal below it, and does so without raising an error. |
| **N2** | Signal 1 — can we list rows assigned to me? | The one signal with a real query. Also probes the `"me"` shorthand trap. |
| **N3** | Can we ask only for what changed since the last sync? | `last_edited_time` bounds the query, but is not "assigned at". Measures the difference. |
| **N4** | Signal 2 — can we find mentions of me in page bodies? | Runs a search-by-name control first, so the "search cannot do this" gap is demonstrated rather than asserted. Also counts the plain-text-name false positives a naive implementation would pick up. |
| **N5** | Signal 3 — can we find mentions of me in comments? | Measures the per-page and per-block cost, and whether inline comments are reachable at all. |
| **N6** | Signal 4 — can we detect replies to my comments? | Tests whether `discussion_id` grouping actually recovers a thread. |
| **N7** | Can we tell when something was handled? | The second half of the question. Answers it per signal, because the answer differs per signal. |
| **N8** | Do results carry what a Cockpit row needs? | Pages carry a `url`; comments carry no permalink and no author name. Both cost something downstream. |
| **N9** | What does one sweep cost, and where does the rate limit bite? | The number that decides whether sweeping is a sync strategy or only a reconciliation strategy. Rate-limit burst is opt-in. |

It finishes by merging all four signals onto the row shape the prototype already renders, so you can look at a real Cockpit inbox built from real Notion data.

## The handled question, in detail

This is the half most likely to be assumed rather than checked, so it gets its own runnable experiment: `npm run handled`.

It cannot be answered by one call, because "handled" is not a field — it is a *change*. So the experiment takes two observations with a human action in between:

```bash
npm run handled          # snapshots all four signals
```

then, by hand in Notion: set a task's status to Done, resolve a comment thread that mentions you, tick a `to_do` that mentions you, delete a mention. Then:

```bash
npm run handled          # diffs, and classifies what the API let us observe
```

The classification is the finding. Expected per signal:

**1. Database assignment — yes, cleanly.** Handled state is just a property value (`status`, `checkbox` or `select`), readable on every query, and `page.properties_updated` fires on the change. This is the case that works the way you would hope. N2 reports which of your databases actually have such a property, because without one there is nothing to watch.

**2. Document mention — no.** Notion has no concept of a page mention being handled. It is text in a block. The only observable change is the mention being *edited away*, which the next sweep sees as the block no longer matching. A read/handled distinction has to live in Cockpit, not in Notion.

There is one exception worth designing around: a mention inside a **`to_do` block** carries `checked: true/false`. An "@you" in a checklist item is the only document mention Notion can tell us was completed.

**3 & 4. Comments — only as a disappearance, and ambiguously.** `GET /v1/comments` is documented as returning "un-resolved" comments, and the comment object has no `resolved` field at all. Notion's own docs state that connections **cannot** "Retrieve resolved comments".

So a resolved thread does not come back marked resolved. It stops coming back.

That is usable — an item Cockpit is tracking that is no longer returned has been dealt with — but **four different things produce an identical disappearance**: resolved, deleted, page trashed, or the integration losing access. The API cannot distinguish them. `handled.js` narrows it by re-fetching the page: if the page still reads back and is not in the trash, that rules out two of the four and leaves *resolved-or-deleted*. For a follow-up inbox both mean "stop showing me this", so the ambiguity is tolerable. It just cannot be labelled more precisely, and a UI that claims "resolved by Jane" would be inventing that.

There is also **no `comment.resolved` webhook event**. The published list is `comment.created`, `comment.updated`, `comment.deleted`. Whether resolving a thread emits `comment.updated`, emits `comment.deleted`, or emits nothing at all is **not documented**, and it decides whether Cockpit can close a comment item in near-real-time or only on a sweep. `npm run webhook` exists to settle exactly that, and it is the single most valuable unknown left in this POC.

**5. And nothing at all for the Notion Inbox itself.** Notion's Inbox has read/unread and archive state. None of it is exposed. Cockpit's own handled state is the source of truth; Notion's is unreadable.

## Setup

### 1. Create an internal integration

1. <https://www.notion.so/profile/integrations> → **New integration**, in your own workspace.
2. Under **Capabilities**, enable:
   - **Read content** — signals 1, 2 and 4
   - **Read comments** — signals 3 and 4
   - **Read user information including email addresses** — how the harness works out which user id is you, and how comment authors get names
3. Copy the **Internal Integration Secret** (`ntn_…`) from the Configuration tab. Not the OAuth section.

### 2. Share content with it

**This is the step that decides whether the run finds anything.** An integration starts with access to nothing.

Open a page → `···` → **Connections** → add your integration. Access is inherited by subpages, so connecting near the top of a teamspace usually covers everything below it.

### 3. Configure

```bash
cp .env.example .env
```

Paste the token into `NOTION_TOKEN` and set `NOTION_PERSON_EMAIL` to your Notion account email.

Optionally set the four `EXPECT_…_URL` variables to pages you *know* contain each thing. That is what turns "some results came back" into a real recall check — the probes then report whether the API actually returned those specific items.

`.env` is gitignored. Do not commit the token.

### 4. Seed the workspace

Signals 2, 3 and 4 cannot be judged on a workspace where they do not occur, and an empty result reads identically to a broken API. Before the first run, in a page the integration can see:

- **a database with a `Person`-type property**, with yourself set on a row, plus a `Status` or checkbox property. This is the one that catches people out: a row whose *title* mentions you is a document mention, not an assignment. Notion's "assigned to me" only exists as a people-type property, and signal 1 has nothing to query without one.
- `@`-mention yourself in a paragraph, and again inside a `to_do` item — the `to_do` case is the only document mention that carries completion state
- `@`-mention yourself in a database row's title or notes column too, so the property path is covered
- type your name as plain text somewhere, so the false-positive count has something to catch
- a comment mentioning you, made **by selecting text** (the normal way), so the block-anchored path is covered
- write a comment yourself and have **a second account** reply to it. Signal 4 ignores your own replies, by design, so a one-person workspace cannot exercise it.
- resolve one comment thread, and point `EXPECT_RESOLVED_COMMENT_PAGE_URL` at that page

The probes report `SKIP` rather than `PASS`/`FAIL` for anything they had no data for, so a thin workspace produces an honest inconclusive rather than a flattering green.

### 5. Run

Visual report in the browser:

```bash
npm run serve
```

Or from the terminal, which also writes `report.json` with every request and the raw evidence:

```bash
npm run probe
```

Include the rate-limit burst:

```bash
npm run probe:ratelimit
```

The handled experiment:

```bash
npm run handled
```

The webhook receiver, which needs a tunnel because Notion only accepts a public HTTPS subscription URL:

```bash
npm run webhook
```

```bash
cloudflared tunnel --url http://localhost:4332
```

Paste the tunnel URL into the integration's **Webhooks** tab. Notion immediately POSTs a one-time `verification_token`, which the receiver prints; copy it back into the Verify box. Then act in Notion and watch which events arrive.

A probe run takes a while and the wall-clock time is itself one of the measurements: with no content search, signals 2–4 are found by crawling every reachable page at roughly 3 requests/second.

### Settling an argument about what the API returned

`inspect.js` dumps raw objects for the cost of a couple of requests, which is faster than re-reading a probe's interpretation of them. It is how both surprises in the validation run above were diagnosed.

```bash
node src/inspect.js schema <data-source-id-or-url>
```

Property names and types, and an explicit verdict on whether any of them could carry an assignment or a handled state.

```bash
node src/inspect.js page <page-id-or-url>
```

Blocks and properties, with mentions called out and yours flagged `<-- YOU`. Also names the block types that cannot hold a mention at all.

```bash
node src/inspect.js comments <page-id-or-url>
```

Page-level discussions **and** per-block discussions, listed separately. This is the one worth running before believing any zero: an inline comment is invisible to the page-level query.

## Reading the result

The verdict is one of:

- **yes** — every probe passed.
- **qualified yes** — all four signals are obtainable, but something needs a workaround. The `partial` probes say what. This is the expected outcome.
- **no** — something the design depends on did not work.
- **inconclusive** — one of the four central signals had no data to test against. Seed the workspace and re-run.
- **blocked** — authentication failed, so nothing was tested.

Two failure modes are worth separating:

- **Access failures** (`unauthorized`, `restricted_resource`, `object_not_found`) usually mean a capability is off, or the content was never shared with the integration. Fixable, and not a finding about the API.
- **Capability failures** — calls succeed, but a signal cannot be retrieved, or costs more than a sync can afford — are the real findings, and would send us back to reconsider the options document.

## What this POC deliberately does not do

- **No OAuth flow.** It uses a pasted internal integration token. OAuth is understood plumbing and would tell us nothing about whether the API can do the job. For a multi-user Cockpit it would be needed, and it would also change the reach question: a public integration is authorised page-by-page by each user.
- **No persistent webhook service.** `webhook.js` is a receiver for answering the resolution question, not a sync engine. It needs a tunnel and does not verify payload signatures.
- **No full workspace sweep by default.** `MAX_PAGES` and `MAX_BLOCK_DEPTH` bound the crawl, and the report says how much was left uncovered. N9 extrapolates to a realistic workspace size instead of pretending the sample was exhaustive.
- **No AI-drafted next action.** Rows carry the raw Notion text through; drafting is Cockpit's job, not this experiment's.
- **No attempt to read the Notion Inbox.** It has no API. That is settled, not untested.

## One alternative worth knowing about

Notion's own **hosted MCP server** is a different surface from the public REST API, authenticated as the *user* rather than as a bot, and it does not have the two limitations that shape this whole POC: its search covers page content semantically, and its comment tool takes an explicit `include_resolved` parameter — meaning resolution state *is* observable there, unlike through `GET /v1/comments`.

That makes it a genuine third option the options document does not consider, and possibly a better fit for signals 2, 3 and 5. It is not free of trade-offs: it is a tool-call interface rather than a data API, it is not designed for background synchronisation, and its access tokens are short-lived (about eight hours). Worth its own investigation rather than a paragraph, but worth recording here before the REST-API limits get mistaken for Notion's limits.

## Sources

Every documented claim above traces to one of these:

- [Search a workspace](https://developers.notion.com/reference/post-search) — titles only
- [Working with comments](https://developers.notion.com/guides/data-apis/working-with-comments) — un-resolved only; connections cannot retrieve resolved comments
- [Comment object](https://developers.notion.com/reference/comment-object) — no `resolved` field; `created_by` is a partial user
- [Webhook event types and delivery](https://developers.notion.com/reference/webhooks-events-delivery) — the full event list, aggregation and delivery guarantees
- [Webhooks setup](https://developers.notion.com/reference/webhooks) — UI-configured, public HTTPS, verification-token handshake, ids-only payloads
- [Data source query filters](https://developers.notion.com/reference/post-database-query-filter) — `people.contains`, the `"me"` shorthand, timestamp filters
- [Request limits](https://developers.notion.com/reference/request-limits) — ~3 requests/second per connection, plus a per-workspace limit scaled by plan
- [Versioning](https://developers.notion.com/reference/versioning) and the [2026-03-11 upgrade guide](https://developers.notion.com/docs/upgrade-guide-2026-03-11) — current version, `archived` → `in_trash`
- [Webhook actions](https://www.notion.com/help/webhook-actions) — the *paid* automation feature, which is not what this POC uses
