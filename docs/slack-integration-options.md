# Slack Integration Options

## Goal

Integrate Slack with a personal follow-up/task inbox so that, for an individual user, we can identify:

- New direct messages sent to the user.
- Messages in channels where the user is explicitly `@mentioned`.
- Ideally, do this without ingesting unrelated Slack conversations.

The integration should be suitable for deployment in an organizational context, where individual employees can enable it without granting unnecessarily broad access to company messages.

---

## Option 1 — Slack Events API

### Approach

Subscribe to Slack message events such as:

- `message.im` for direct messages.
- `message.channels` for public channels.
- `message.groups` for private channels.
- Potentially `message.mpim` for group DMs.

For channel messages, inspect the message text for the user's Slack ID:

```text
<@USER_ID>
```

Slack does not expose an equivalent of `app_mention` for mentions of a normal human user. Therefore, detecting an `@mention` requires receiving the underlying message event and filtering it ourselves.

### Pros

- Push-based: events arrive immediately.
- No polling required.
- Good fit for continuously synchronizing new activity.
- Can detect new DMs as they arrive.
- Can reliably detect explicit Slack `@mentions`.

### Cons

- Requires subscribing to a much broader set of messages than we actually need.
- The webhook/backend may receive messages that do not reference the user and must discard them after inspection.
- Creates a significant privacy/security concern in an organizational deployment.
- Requested permissions are broader than the actual product requirement.
- Security teams may reasonably object to an application receiving potentially sensitive Slack conversations merely to detect mentions.
- Slack has an `app_mention` event for apps/bots, but no equivalent `user_mention` event for normal users.

### Assessment

Technically the best solution for real-time synchronization, but unattractive for an organization-facing integration because of excessive data access.

---

## Option 2 — Traditional Slack Message Search

### Approach

Use Slack's message search APIs with a user token to search for:

- Explicit mentions of the authenticated user.
- Direct messages.
- Potentially messages containing the user's name as plain text.

For example, an explicit mention is represented by Slack as:

```text
<@USER_ID>
```

### Pros

- Query only the information we are interested in.
- Avoids continuously receiving all channel traffic.
- Uses the permissions/access of the individual authenticated user.
- Can potentially retrieve historical references as well as recent ones.

### Cons

- Pull-based rather than push-based.
- Requires polling if automatic synchronization is required.
- Search/API availability and rate limits need to be considered.
- Plain-text references such as `Michael can you check this?` cannot be distinguished reliably from unrelated uses of the name.
- Explicit `@Michael` mentions are much more reliable.

### Assessment

Better privacy characteristics than the Events API, but the older search APIs are less attractive for building a modern user-authorized integration.

---

## Option 3 — Slack Real-time Search API

Documentation: Slack **Real-time Search API**, specifically `assistant.search.context`.

### Approach

Authorize Slack access on behalf of the individual user and query Slack for targeted information.

Two main searches are required.

#### Direct messages

Search messages restricted to DM conversations, for example using `channel_types: ["im"]` / DM search filters.

#### Mentions

Search channel messages for the authenticated user's explicit Slack mention:

```text
<@USER_ID>
```

Results are limited to information that the authenticated user is authorized to access.

### Pros

- Much narrower data access than subscribing to all message events.
- Backend receives relevant search results rather than an entire stream of unrelated Slack messages.
- User-scoped authorization maps well to a personal follow-up inbox.
- Can search both DMs and channel messages.
- Can retrieve explicit `@mentions` reliably.
- Better privacy/security story for organizational deployment.
- Supports retrieving messages since a previous synchronization point.
- Can also be used interactively when the user opens or refreshes the follow-up inbox.

### Cons

- Pull-based rather than push-based.
- Slack positions Real-time Search primarily for searches triggered by user interactions, rather than continuous background polling.
- `assistant.search.context` has a documented limit of approximately **10 requests/minute per user**.
- Slack also applies **daily query limits but does not publish the exact numeric limit**.
- Therefore we should not design around aggressive polling such as every few minutes.
- Availability is restricted: Real-time Search is intended for **internal Slack apps or apps published in the Slack Marketplace/Directory**; an arbitrary unlisted distributed app cannot simply rely on it.
- A plain-text reference to someone's name is inherently less reliable than an explicit Slack `@mention`.

### Assessment

Best match for the privacy and deployment requirements, provided its usage model and Slack app distribution restrictions are acceptable.

---

## Comparison

| Approach | Real-time | DMs | @mentions | Receives unrelated messages | Organization-friendly |
|---|---|---|---|---|---|
| Events API | Yes | Yes | Yes, by filtering messages | **Yes** | Poor/Moderate |
| Traditional Search API | No | Yes | Yes | No | Good |
| Real-time Search API | No | Yes | Yes | **No** | **Best** |

---

## Selected Approach — Real-time Search API

The preferred approach is the **Slack Real-time Search API using user authorization**.

> A proof of concept that tests whether this actually works against a live workspace lives in
> [poc/slack-realtime](../poc/slack-realtime/README.md). It probes the four assumptions this
> section makes: that DMs can be retrieved without naming a topic, that `<@USER_ID>` mention
> search is precise, that `after` supports incremental sync, and that results carry enough
> fields to build a row without extra API calls.

### Validation status — August 2026

Measured against a live workspace on the **free** plan (no Slack AI Search), so keyword search only.

| Assumption | Result |
|---|---|
| Retrieve DMs without naming a topic | **Confirmed.** `query: "*"` with `disable_semantic_search: true` returns recent DMs, so the endpoint can be used feed-style. |
| `<@USER_ID>` mention search is precise | **Confirmed.** Returned every genuine mention and nothing else. |
| `after` supports incremental sync | **Confirmed.** No result fell outside the requested window. |
| Results are complete enough for a row | **Confirmed.** `permalink`, `message_ts`, `content`, `channel_id`, `channel_name`, `author_name`, `author_user_id`, `is_author_bot` — no second API call needed. |
| Works on a free plan | **Partly.** API access is gated by app type, not plan, so a free workspace can call it. Semantic and natural-language queries need Slack AI Search (Business+ and above) and returned nothing here. |

### Three signals, not two

The POC established that Cockpit can build its inbox from three signals, and that the third changes the design.

| Signal | Query | Sync model | Confidence |
|---|---|---|---|
| Direct messages | `channel_types: ["im","mpim"]`, `query: "*"` | `after` = high-water mark | Inferred |
| Mentions | `query: "<@USER_ID>"` | `after` = high-water mark | Inferred |
| **Saved messages** | `query: "is:saved"` | Full list + local diff | **Explicit** |

DMs and mentions are inferences about what the user might care about. A saved message is the user saying so directly, which makes it the highest-confidence input available — and it costs no extra scopes and no Slack AI Search. It also sidesteps the `@channel`/`@here` gap entirely, since anything can be saved regardless of how it arrived.

Two constraints shape how it is used. `is:saved` works only as a *query term*; the documented `modifiers` argument is silently ignored, returning the unfiltered window rather than erroring. And `after` filters on message time, not save time, with no `saved_at` field returned — so saving an old message is a new intention on an old timestamp. Saved items must therefore be synced by pulling the full list and diffing locally, not by advancing a high-water mark.

Three handling requirements the POC surfaced, none of them blocking:

- `content` renders mentions as `<@U123|Display Name>`, not `<@U123>`. Matching the bare token finds nothing.
- Slack markup (mentions, channel links, labelled URLs) arrives unwrapped and must be rendered.
- Bot messages (`is_author_bot`) and self-authored mentions (`author_user_id`) come through and must be filtered, or Slackbot notices and your own messages land in the inbox.

Still unvalidated: semantic retrieval, and whether §"Synchronization strategy" holds up under Slack's prohibition on background polling.

The main reason is data minimization.

With the Events API, detecting a human user's mentions requires subscribing to general message events. Our infrastructure would therefore receive potentially large amounts of company conversation data that has nothing to do with the follow-up inbox.

Real-time Search allows us to ask Slack specifically for the information relevant to the authenticated user:

```text
Slack
  │
  │ User OAuth
  ▼
Follow-up service
  │
  ├── Search DMs
  │
  └── Search <@USER_ID> mentions
          │
          ▼
     Follow-up inbox
```

This provides a substantially cleaner permission and security model for deployment inside organizations.

### Synchronization strategy

Because Slack does not position Real-time Search as a continuous polling API, the initial implementation should avoid aggressive background synchronization.

A reasonable first version is:

```text
User opens / refreshes follow-up inbox
             ↓
Query Slack for activity since last sync
             ↓
New DMs + explicit @mentions
             ↓
Add relevant items to follow-up inbox
```

If background synchronization becomes a hard requirement, we need to validate acceptable polling behavior and daily Real-time Search limits with Slack before relying on it.

---

## Important Limitation

Slack currently lacks the ideal API primitive for this use case:

```text
user_mention
```

An event like this would allow an application to receive:

```text
Michael was @mentioned in #engineering
```

without receiving the contents of every other message in `#engineering`.

Slack exposes `app_mention` for bots/apps, but not an equivalent event for ordinary Slack users.

Therefore there is currently a fundamental trade-off:

```text
Events API
Push / immediate
BUT broad message access

             vs.

Real-time Search
Targeted / privacy-friendly
BUT pull-based and rate-limited
```

For an organization-facing product, we prefer the second trade-off and therefore select **Real-time Search** as the initial Slack integration approach.
