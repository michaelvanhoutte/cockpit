# POC — Slack Real-time Search API

[docs/slack-integration-options.md](../../docs/slack-integration-options.md) picks **Option 3, the Slack Real-time Search API** (`assistant.search.context`) as Cockpit's Slack integration, on data-minimisation grounds. That document is an argument on paper. This POC turns it into an experiment.

It does not try to build the integration. It answers one question: **would this actually work?**

## The three signals

Cockpit can build a follow-up inbox from three distinct signals. They behave differently enough that the difference drives the design.

| Signal | How Cockpit asks for it | Sync model | Confidence |
|---|---|---|---|
| **Direct messages** | `channel_types: ["im","mpim"]`, `query: "*"`, `disable_semantic_search: true` | `after` = last high-water mark | Inferred |
| **Mentions** | `query: "<@USER_ID>"` | `after` = last high-water mark | Inferred |
| **Saved messages** | `query: "is:saved"` — **as a query term, never the `modifiers` argument** | Pull the full list, diff locally. **Not** `after`. | **Explicit** |

The first two are inferences: someone sent you something, or typed your name, so you probably care. The third is you stating the intention outright, which makes it the highest-confidence input available — and it costs no extra scopes.

Two traps are load-bearing here, both confirmed by live testing:

- **`is:saved` only works inside the query string.** The documented `modifiers` argument is *silently ignored* — it returns the full unfiltered window, which looks like success until you compare it against a control. That is why `probeSaved` runs an unfiltered control first.
- **`after` filters on message time, not save time**, and no `saved_at` field is returned. Saving a three-week-old message is a new intention on an old timestamp, so an `after` window would never surface it. Saved items therefore need a full-list-and-diff sync, unlike the other two.

## What it tests

Each probe isolates one thing the design in the options document silently assumes.

| Probe | Question | Why it matters |
|---|---|---|
| **P0** | Is the user token valid, and does it carry the `search:read.*` scopes? | If Real-time Search is not enabled for the app, this is where it shows. |
| **P0b** | Does this workspace have Slack AI Search enabled? | Semantic and natural-language queries only work on plans that include it. Without this check, a plan limitation reads as an API limitation. |
| **P1** | Can we retrieve recent **DMs** without naming what we are looking for? | The biggest risk. Cockpit wants "everything new"; the endpoint is a *search*, and always wants a query. |
| **P2** | Can we find channel messages containing `<@USER_ID>`? | Measures **precision** too: a semantic search for a name returns messages that merely talk about you. |
| **P3** | Can we retrieve messages the user explicitly **saved**? | The only explicit signal. Runs an unfiltered control alongside, because the `modifiers` form fails by returning everything rather than by erroring. |
| **P4** | Does the `after` timestamp bound results? | Incremental "since last sync" is the synchronisation strategy for DMs and mentions. |
| **P5** | Do results carry permalink, author, channel and ts? | If not, every row needs extra `conversations.info`/`users.info` calls, which weakens the privacy argument. |
| **P6** | Where does the rate limit actually bite? | Opt-in, because it burns quota. Documented at ~10 requests/min per user. |

It finishes by merging all three signals onto the row shape the prototype already renders, deduped on timestamp with the explicit signal winning, so you can look at a real Cockpit inbox built from real Slack data.

## Findings so far

Confirmed against a live free workspace (`Conselit`, no Slack AI Search), August 2026.

**The API is reachable on a free plan.** Auth, the six `search:read.*` user scopes, and `assistant.search.context` all worked. Free-plan status does not block access; it blocks semantic search only.

**Broad enumeration works.** `query: "*"` with `disable_semantic_search: true` returns recent messages without naming a topic, so the endpoint can be used feed-style and not only as a search box. This was the assumption most likely to sink the approach. The natural-language equivalent returns nothing without Slack AI Search.

**Mention search is exact.** Querying the literal `<@USER_ID>` returned every genuine mention and nothing else — 2 of 2, including the message flagged via `EXPECT_MENTION_PERMALINK`. No client-side filtering needed for precision, though see the markup note below.

**`after` bounds results correctly**, so incremental "since last sync" is expressible.

**Results are self-sufficient.** A message comes back as:

```json
{
  "author_name": "Michael Vanhoutte",
  "author_user_id": "U0BNUKXK92B",
  "team_id": "T0BP3PZ8199",
  "channel_id": "C0BP3PZKMT5",
  "channel_name": "all-conselit",
  "message_ts": "1786476478.622169",
  "content": "<@U0BNUKXK92B|Michael Vanhoutte> test1",
  "is_author_bot": false,
  "permalink": "https://conselit.slack.com/archives/C0BP3PZKMT5/p1786476478622169"
}
```

Everything a Cockpit row needs, including the deep link, with no follow-up `users.info` or `conversations.info` call. That is the data-minimisation argument holding in practice.

### Three things an integration must handle

These cost a wrong result before they were understood, so they are worth stating plainly.

1. **Mentions are not rendered as the bare token.** `content` contains `<@U123|Display Name>`, not `<@U123>`. Matching on `<@U123>` misses every real mention while the *query* for `<@U123>` still works. See `mentionsUser()` in `src/normalize.js`.
2. **Slack markup leaks into the text.** User mentions, channel links and labelled URLs all arrive wrapped. See `renderSlackText()`.
3. **Bot and self-authored messages come through.** Slackbot notices arrive with `is_author_bot: true`, and your own `@mentions` of yourself are returned like anyone else's. Both are noise in a follow-up inbox and must be filtered on `is_author_bot` and `author_user_id`.

### "New" is the client's job, not the API's — and why probe runs repeat themselves

There is no server-side notion of unseen. `after` is a parameter *you* set, and the probe battery deliberately sets it to a fixed `LOOKBACK_DAYS` window on every run, which is why repeated runs return the same messages. That is intentional: a probe needs stable, repeatable data to measure against. A battery that advanced a high-water mark would return nothing on its second run and prove nothing.

`npm run incremental` demonstrates the real loop and pins the boundary semantics. Measured:

| Sync | `after` | Returned |
|---|---|---|
| 1 — cold start, 7-day window | 7 days ago | 6 messages |
| 2 — after = high-water mark | `1786476651` | **1** (the newest message, again) |
| 3 — after = high-water mark + 1s | `1786476652` | 0 |

**`after` is inclusive of the boundary second.** So storing the raw high-water mark re-delivers the newest message on every sync. Cockpit must **dedupe on `message_ts`** rather than advancing to `maxTs + 1` — several messages can share the same second, and the +1 shortcut would silently skip them.

That is the whole "new messages" mechanism: persist the newest `message_ts` you have processed, pass it as `after`, dedupe the boundary. Nothing else is needed, and nothing else is available.

### Completeness — "all new DMs", not just "some"

`npm run completeness` attacks the second claim, which is what an inbox actually depends on.

**Full recall on a known message set (confirmed).** Five deliberately-posted messages (1 DM, 4 channel messages) were all returned by the broad query: **5/5**. The channel's `joined #all-conselit.` system message was *not* indexed, so join/leave noise does not need filtering.

**Real mentions are distinguished from plain-text lookalikes (confirmed).** Of the four channel messages, two are stored as canonical mentions (`<@U0BNUKXK92B|Michael Vanhoutte>`) and one as the literal string `@U0BNUKXK92B`. The mention query returned exactly the two canonical ones and ignored the literal — which is correct, since the literal does not notify anyone. This is the concern raised in the options document about plain-text name references, and Slack's index handles it properly.

**Pagination is coherent (confirmed).** Paging the same window with `limit: 1` across 7 cursor pages returned exactly the same 6 messages as a single `limit: 20` page — no drops, no duplicates. So a sync window holding more than one page is safe, which is the failure that would have mattered most at volume.

**Broadcast mentions are a coverage gap (by construction).** `@channel`, `@here`, `@everyone` and user-group pings notify you, but Slack encodes them as `<!channel>`, `<!here>`, `<!subteam^S…>` — none of which contain your user id. A `<@USER_ID>` query cannot return them. If Cockpit should surface "the team was pinged in a channel I'm in", that needs its own queries on top of the mention search. Untested on this workspace because no such message exists in it yet; post one and re-run C3.

**Still unproven:** whether `query: "*"` matches a message with nothing to index — emoji-only, link-only, or file-only. A keyword index may have no token to match, which would put silent holes in DM enumeration. Set `EXPECT_ALL_DM_PERMALINKS` / `EXPECT_ALL_MENTION_PERMALINKS` to a comma-separated list of permalinks and re-run C2 to settle it.

### Saved messages ("Save for later") — works, with one trap

An explicit save is a much stronger signal than any heuristic: it is the user saying *"I want to process this later"*. `npm run saved` establishes that it is usable.

**It works — but only as a query term, not as the documented argument.** Verified by a clean before/after: with nothing saved the filter returned the full 6-message window; after saving exactly one message it returned exactly that message.

| Spelling | Result |
|---|---|
| `modifiers: "is:saved"` (string, array, or object) | silently ignored — returns the full window |
| **`query: "is:saved"`** | **works — returns exactly the saved message** |
| `term_clauses` | rejected, `invalid_arguments` |
| `stars.list` (legacy) | needs `stars:read`, and Slack says it no longer reflects new saves |

So ignore the `modifiers` argument; put the filter in the query string.

Characterised further:

- **No extra scopes.** It rides on the existing search scopes, unlike unread state.
- **No Slack AI Search needed.** Works with `disable_semantic_search: true`, so it is fine on a free plan.
- **`channel_types` still applies**, so saved DMs and saved channel messages can be queried separately.

**The trap: `after` filters on message time, not save time.** Confirmed — querying `is:saved` with `after` set past the saved message's timestamp returns nothing, even though the message is still saved. Results carry `message_ts` only; there is no `saved_at` field, so the API cannot say *when* something was saved.

The consequence is concrete: saving a three-week-old message is a brand-new intention attached to an old timestamp, and an incremental `after` window would never surface it. **Cockpit must pull the entire saved list on each sync and diff it locally** rather than using `after`. That is cheap — one call, and the list is bounded by how much the user actually saves — but it is a different sync model from DMs and mentions, which do use `after`.

Untested: whether un-saving removes an item from the results (it should, and would give Cockpit a natural "handled" signal).

### Unread state is not available, and probably not wanted

Real-time Search cannot answer "which DMs are unread" or "which channels have unread mentions". It has no unread request parameter and its results carry no read state — unread lives on the *conversation*, not the message. Verified with `npm run unread`:

| Method | Result |
|---|---|
| `users.conversations` | `missing_scope` — needs `channels:read, groups:read, im:read, mpim:read` |
| `conversations.info` (for `last_read` / `unread_count`) | `missing_scope` — same four |
| `users.counts` (legacy per-channel `mention_count`) | `not_allowed_token_type` — rejects user tokens |

So mirroring Slack's unread badges would mean adding four conversation-scopes on top of the search scopes. Those grant conversation *metadata* (which channels and DMs exist, their unread counts), not message content, so it is a smaller widening than the Events API — but it is a widening, and it makes Slack the source of truth for Cockpit's inbox.

The better answer is that Cockpit does not need Slack's unread flag. It needs *"new since Cockpit last synced"*, which is `after` plus its own high-water mark, already confirmed by P4. The two are not the same thing, and the difference favours Cockpit: a DM you read on your phone while walking is unread=false but still owes a reply, and that is exactly the item a follow-up inbox exists to catch. Conversely, something you have handled in Cockpit should not reappear because it is still bold in Slack.

### Still open

Semantic and natural-language retrieval, which needs a Business+ workspace. Everything above was measured with keyword search only, so treat it as a lower bound.

## Which Slack plan do you need?

Two different gates, and it is worth keeping them apart.

**The API itself** is restricted by *app type*, not by plan: directory-published apps and internal apps only. A free workspace can create an internal app, so you can very likely get a token and make calls.

**Semantic search is restricted by plan.** Slack's docs: *"Semantic search is available only on workspaces within plans that include Slack AI Search."* Slack AI Search sits in **Business+ and above** — not Free, not Pro. On a free workspace `disable_semantic_search: true` keyword matching is the realistic ceiling, and natural-language queries like *"anything sent to me recently"* have nothing behind them.

That matters here because half of what this POC tests is whether Cockpit can ask Slack broad, feed-shaped questions. On a free workspace that half cannot be answered.

So:

- **Free workspace** — useful for the mechanical questions (P2 mention precision with keyword search, P3 saved messages, P4 windowing, P5 result shape, P6 rate limits) and for building ground truth, since you control every message in it. Not useful for judging semantic retrieval.
- **Business+ workspace** — needed before any *"yes, this works"* is trustworthy.

P0b calls `assistant.search.info` and reports `is_ai_search_enabled` before anything else runs, so every report says which of these two situations it was produced in. A run without AI Search is marked with a plan caveat and should be read as a lower bound.

## Setup

### 1. Create an internal Slack app

Real-time Search is restricted to **directory-published apps and internal apps**. An unlisted distributed app cannot use it. For Azumuta an internal app is the right shape.

1. <https://api.slack.com/apps> → **Create New App** → From scratch, in the Azumuta workspace.
2. **OAuth & Permissions → User Token Scopes**, add:
   - `search:read.public`
   - `search:read.private`
   - `search:read.im`
   - `search:read.mpim`
   - `search:read.users`
   - `search:read.files`
3. **Install to Workspace**, then copy the **User OAuth Token** (`xoxp-…`).

A bot token will not work here. Bot calls to `assistant.search.context` require an `action_token` that only arrives inside a Slack event payload, which means the app is being driven from inside Slack rather than from Cockpit.

> If the probes come back with an access or program error rather than a scope error, the workspace is not enrolled. Slack's docs point at `feedback@slack.com` to request access.

### 2. Configure

```bash
cp .env.example .env
```

Paste the token into `SLACK_USER_TOKEN`. Optionally set `EXPECT_MENTION_PERMALINK` and `EXPECT_DM_PERMALINK` to the permalinks of a message you *know* mentions you and a DM you *know* you received (Slack message "···" menu → Copy link). The probes then check whether the API actually returned those specific messages, which turns a vague "some results came back" into a real recall check.

`.env` is gitignored. Do not commit the token.

### 3. Run

Visual report in the browser:

```bash
npm run serve
```

Or from the terminal, which also writes `report.json` with every request and raw response shape:

```bash
npm run probe
```

Include the rate-limit burst:

```bash
npm run probe:ratelimit
```

To settle an argument about what the API actually returned, dump one raw response for the cost of a single call:

```bash
node src/inspect.js "<@U0BNUKXK92B>" channels
```

A full run takes about a minute: the harness paces itself at roughly one request every 6.5 seconds to stay inside the documented per-user limit.

## Reading the result

The verdict is one of:

- **yes** — every probe passed. The options document's Option 3 holds up.
- **qualified yes** — it works, but something needs a workaround. The `partial` probes say what.
- **no** — something the design depends on did not work.
- **blocked** — authentication failed, so nothing was actually tested.

Two failure modes are worth separating when you read it:

- **Access failures** (`invalid_auth`, `missing_scope`, `not_allowed_token_type`, program errors) mean the app is not set up or not enrolled. Fixable.
- **Capability failures** (calls succeed, but DMs cannot be enumerated without a query, or mention search returns imprecise results) are the real finding, and would send us back to Option 1 or Option 2.

## What this POC deliberately does not do

- **No OAuth flow.** It uses a pasted token. OAuth is well-understood plumbing and would not tell us anything new about whether the API can do the job. Note for later: Slack requires an HTTPS redirect URL, so the real flow needs a deployed callback, not `localhost`.
- **No background polling.** Slack states the API is "intended to be used in response to user interactions" and prohibits background scraping unrelated to user queries. The options document already proposes sync-on-open for exactly this reason. If continuous background sync ever becomes a hard requirement, that needs clearing with Slack rather than measuring here.
- **No AI-drafted next action.** Rows carry the raw Slack text through; drafting is Cockpit's job, not this experiment's.
