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

**Conclusion:** **Selected as the primary integration mechanism.**

## Selected approach

Use **Notion Integration/Connection Webhooks + the Notion API**.

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

Webhooks should be the primary mechanism, but a **periodic
reconciliation query** is worth adding eventually.

That gives us:

``` text
Webhooks                     Periodic reconciliation
   │                                  │
   └──────────────┬───────────────────┘
                  ↓
          Notion synchronization
                  ↓
          Our action/follow-up inbox
```

Webhooks provide low-latency updates, while periodic querying protects
against missed events, deployment downtime, interpretation bugs, or
synchronization drift.

## Important limitation

This solution does **not** provide API access to the Notion Inbox
itself.

Instead, we are effectively building our own actionable view by
interpreting Notion objects and changes. Structured database tasks with
an Assignee property should be relatively reliable. Reconstructing every
type of notification that Notion itself places in its Inbox---especially
arbitrary mentions or inline action items---may require additional
investigation and may not be fully possible through the public API.
