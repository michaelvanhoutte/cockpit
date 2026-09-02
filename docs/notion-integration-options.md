# Notion Integration Options

## Goal

The goal is to integrate Notion with our own **action/follow-up inbox**,
so that items requiring my attention can be detected automatically. In
particular, we considered how to detect:

-   tasks assigned to me;
-   mentions or comments involving me;
-   action items created or changed in Notion;
-   ideally, the same kind of information that appears in the Notion
    Inbox.

A key constraint is that the solution should work with the **Notion Free
plan** where possible.

## Options considered

### 1. Access the Notion Inbox through the API

**Idea:** Query the same notifications that are visible in Notion's
Inbox directly through the API.

**Pros**

-   Conceptually the cleanest solution.
-   Would provide a single aggregated source for assignments, mentions,
    comments, etc.
-   No need to reconstruct notification logic ourselves.

**Cons**

-   **Not supported by the public Notion API.**
-   There is no public Inbox, Notifications, or Activity endpoint.
-   The internal aggregation performed by the Notion Inbox is therefore
    not directly accessible.

**Conclusion:** Rejected because the required API does not exist.

------------------------------------------------------------------------

### 2. Periodically query Notion databases/data sources

**Idea:** Poll relevant Notion databases and find tasks where the
`Assignee`/People property contains my Notion user.

**Pros**

-   Uses standard, documented Notion APIs.
-   Straightforward for structured task databases.
-   Allows querying the complete current state, which is useful for
    reconciliation.
-   Easy to identify tasks assigned to a particular user.

**Cons**

-   Requires polling.
-   Only works well when action items are represented as structured
    database entries.
-   Does not reproduce everything appearing in the Notion Inbox.
-   Arbitrary mentions/comments/action items elsewhere in documents are
    harder to discover.
-   Requires knowing which databases/data sources should be searched.

**Conclusion:** Technically viable, especially as a fallback or
reconciliation mechanism, but not ideal as the primary event-detection
mechanism.

------------------------------------------------------------------------

### 3. Use Notion email notifications

**Idea:** Let Notion send notification emails and process those emails
instead of integrating deeply with the Notion API.

**Pros**

-   Very simple architecture if all relevant notifications arrive by
    email.
-   Email is easy to ingest and process.
-   Could potentially capture several different types of Notion
    notifications through one channel.

**Cons**

-   Notion does not necessarily email every event that appears in the
    Inbox.
-   In particular, behavior around tasks assigned to yourself is not
    reliable for this use case.
-   Notification preferences and Notion's notification rules affect what
    is received.
-   Parsing human-oriented emails is more brittle than consuming
    structured API events.
-   Adds unnecessary latency and dependency on email delivery.

**Conclusion:** Rejected as the primary mechanism because it cannot
reliably represent all actionable Notion events.

------------------------------------------------------------------------

### 4. Notion database automation → "Send webhook"

**Idea:** Configure Notion database automations that explicitly call our
webhook when relevant database changes occur.

**Pros**

-   Event-driven rather than polling.
-   Rules can be configured directly in Notion.
-   Can target specific business events.

**Cons**

-   This is a separate Notion automation feature, not the API's
    Integration/Connection Webhooks.
-   **Webhook Actions are a paid-plan feature**, which conflicts with
    the Free-plan requirement.
-   Rules have to be configured per relevant database/workflow.
-   Less suitable as a generic workspace-wide integration.

**Conclusion:** Rejected, primarily because it requires a paid Notion
plan and is more workflow-specific than necessary.

------------------------------------------------------------------------

### 5. Notion Integration/Connection Webhooks

**Idea:** Create a Notion API connection and subscribe an HTTPS endpoint
to Notion webhook events. When an object changes, retrieve its current
state through the API and determine whether the change creates an action
for me.

Example flow:

``` text
Notion object changes
        ↓
Notion Connection Webhook
        ↓
Our webhook endpoint
        ↓
Retrieve changed page/object through Notion API
        ↓
Inspect properties/content
        ↓
Relevant to me?
        ↓
Create/update item in our action inbox
```

**Pros**

-   Event-driven: no need to continuously poll Notion.
-   Part of the API/integration infrastructure rather than database
    automations.
-   Available independently of the paid "Send webhook" automation
    feature.
-   Can notify us about changes to pages, data sources/databases and
    comments.
-   A `page.properties_updated` event can trigger inspection of a task's
    Assignee, Status, Due Date, etc.
-   `page.content_updated` can signal that ordinary page content
    changed.
-   Good basis for keeping our own action inbox synchronized.

**Cons**

-   There is no semantic **"assigned to me"**, **"mentioned me"**, or
    **"new Notion Inbox notification"** webhook.
-   A webhook generally signals that an object changed; our service
    still needs to fetch and interpret the object.
-   Detecting assignments in structured task databases is much easier
    than detecting arbitrary action items inside documents.
-   We need to keep some state if we want to distinguish "this was newly
    assigned to me" from "this object changed while already assigned to
    me."
-   Webhook delivery is not intended to be a strict real-time audit log;
    events can be aggregated/delayed.
-   The connection only sees content to which it has access.

**Conclusion:** Selected as the primary integration mechanism. **Superseded — see
"Revision, August 2026" below.** The API half of this option is confirmed and still
required; the webhook half has been replaced by Option 3's email notifications, which do
the same job without an always-on HTTPS endpoint.

## Revision, August 2026 — email as the change detector

Measured evidence, from the POC and from live notification emails, revises two of the
conclusions above. Option 3 was rejected as the primary mechanism on the grounds that
Notion "does not necessarily email every event that appears in the Inbox" and that
"parsing human-oriented emails is more brittle than consuming structured API events".
**Both concerns turn out to be weaker than assumed.**

Notion sends **one email per event**, promptly: a comment made at 20:26 produced an email
at 20:28, and a mention at 20:20 produced one at 20:23. That is comparable to webhook
delivery, which Notion guarantees only within 5 minutes.

More importantly, the emails are **not** human-oriented only. The tracking link in each
one is a base64-encoded, zlib-compressed query string that can be decoded **offline**,
with no HTTP request and without consuming the tracked click. It contains:

``` text
l            = https://app.notion.com/p/<slug>-<page-id>#<block-id>
t            = email_subtype=user-mentioned
metadata     = {"space_id": "<workspace-id>"}
email_uuid   = <stable id, usable for deduplication>
```

So the page id, the specific **block** id, a machine-readable **event subtype**, the
workspace id and a dedupe key are all available without parsing any prose. That removes
the brittleness objection entirely — and note the subject lines were in Dutch, so any
parser keyed on wording would have been locale-dependent, while `email_subtype` is not.

The caveat is that this link format is undocumented and internal, so it can change without
notice. It fails safely, though: a decode either works or throws, rather than silently
mis-reading an event.

**Why this beats webhooks for Cockpit specifically:**

- **No always-on component.** Notion requires a public HTTPS endpoint for webhooks, plus a
  manual verification-token handshake. Email needs neither.
- **Strictly more durable.** Webhook delivery is at-most-once with retries abandoned after
  ~24 hours. An email waits in the mailbox until processed.
- **It carries the block id**, which removes the worst cost in the whole design. Comments
  cannot be found by any query and cannot be windowed by timestamp (see below), so without
  a pointer they need a full block-level sweep. The email hands over the exact block.
- **Cockpit already ingests email**, so this adds no new infrastructure at all.

**What email still cannot do**, and why the API half of Option 5 remains necessary:

- There is no "comment resolved" or "task completed" email. Notifications are append-only:
  they say something started, never that it finished. Closing an item requires re-reading
  it through the API.
- Email awareness is **broader than API actionability**. Confirmed concretely: a
  notification arrived for a page that the integration could not read
  (`object_not_found` — the page had not been shared with it). Email will therefore trigger
  on objects Cockpit cannot enrich or close unless sharing is comprehensive.
- Whether being added to a **Person property** emails at all is still unverified. This is
  the one part of the original Option 3 objection that stands: the document's specific
  concern was assignment behaviour, and it has not yet been tested on either path.

### Revised selected approach

**Email notifications as the change detector + the Notion API as interpreter and closer**,
with a periodic API sweep for backfill and reconciliation. A hybrid of Options 3 and 5 that
this document did not originally consider.

``` text
Notion emails a notification
        ↓
Decode the tracking link offline  ->  page id, block id, event subtype
        ↓
Fetch that object through the API  (1-2 requests, no sweep)
        ↓
Relevant to me?  ->  create/update the Cockpit item
        ↓
On later syncs, re-read tracked items to detect handled
        ↓
Occasional full sweep: backfill, and anything email missed
```

## Original selected approach (webhook-based)

Use **Notion Integration/Connection Webhooks + the Notion API**.

> A proof of concept that tests whether this actually works lives in
> [poc/notion-inbox](../poc/notion-inbox/README.md). It probes the four signals this
> section assumes are obtainable — assignments, document mentions, comment mentions and
> replies to my comments — plus the question this document does not ask: whether Notion
> can tell us when one of them was later marked as handled.
>
> Three things it establishes on paper before any run, which change the design sketched
> below:
>
> - **`POST /v1/search` matches titles only**, so mentions inside document bodies cannot
>   be searched for at all. Signals 2, 3 and 4 are sweeps over every reachable page, not
>   queries. That makes reconciliation the primary read path and webhooks the optimisation,
>   rather than the other way round.
> - **`GET /v1/comments` returns un-resolved comments only**, and the comment object has no
>   `resolved` field. A resolved thread does not come back marked resolved; it stops coming
>   back — which is a usable handled signal, but indistinguishable from deletion.
> - **The paid-plan concern in Option 4 does not apply here.** "Send webhook" is an
>   automation action; integration webhooks are a separate feature and are not plan-gated.
>   The free plan is fine.

The webhook is used as the **change detector**, while the API is used to
retrieve and interpret the actual Notion object.

For structured tasks, the basic algorithm is:

``` text
Receive page.properties_updated
        ↓
Fetch page
        ↓
Is this a task/action object?
        ↓
Is Assignee == me?
        ↓
Check status / due date / other relevant properties
        ↓
Create or update action in our own inbox
```

Comments and page-content changes can later be handled similarly if they
prove useful.

### Recommended hybrid

Webhooks are the primary mechanism for low-latency updates, with a **periodic reconciliation query** behind them as protection against missed events, deployment downtime, interpretation bugs and synchronization drift.

## Important limitation

This gives **no API access to the Notion Inbox itself**: it builds our own actionable view by interpreting Notion objects and changes. Structured database tasks with an Assignee property should be reliable; reconstructing every notification Notion itself places in its Inbox — arbitrary mentions, inline action items — may not be fully possible through the public API.
