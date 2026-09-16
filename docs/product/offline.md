# Offline

## 10. Offline / local-first behavior

The local copy serves **instant rendering** first and **offline availability** second (problem 9). Because offline is the rare case it gets the simple version of everything: a cache plus a queue, no peer-to-peer sync, no elaborate conflict resolution.

- A local copy of synced Items, associations, panels, dashboards and workspaces makes the app **viewable and triageable offline**.
- **Reads offline:** current status, already-synced items, dashboards.
- **Writes offline:** triage actions are captured locally and **queued**.
- **On reconnect:** queued changes sync to the backend and to source apps where two-way sync applies, and new items pull down. Recommended conflict rule: last-write-wins per field, with source apps read-only unless two-way sync is explicitly enabled.
- New incoming messages only arrive when online; offline means the app still works with what it already has.

### 10.1 Staleness and reconciliation (keeping the copy honest)

The source apps remain the source of truth for everything they own. The rule that keeps this tractable is a strict split of every Item's fields:

- **Source-owned facts** — whether the underlying object still exists, its content, its state at the source. Every re-sync overwrites the cache unconditionally; the app never argues with the source about the source's own data.
- **App-owned facts** — associations, focus flags, whether it has been finished with, edited next-action labels, panel placement, manual sort order. Reconciliation never touches these.

Convergence is layered, cheapest first, and a source change should have the same effect as processing the item here (so completing something in Notion counts as done, per problem 1):

- **Push where the source offers it** — Slack events and Gmail push notifications, near-real time at almost no cost.
- **Periodic delta re-sync** for sources without reliable push (Notion is polling-based), on a modest interval while the app is open and on focus or launch.
- **Opportunistic re-verification** — on returning from a click-through (a moment the app already watches for the round-trip prompt — "action cards", above), re-fetch that item.
- **Tombstones instead of silent deletes** — an object that disappears or completes at the source marks the Item *resolved at source* rather than vanishing. Whether that surfaces for confirmation is open decision #18.

Each Item carries a *last-verified* timestamp, and a Panel can show how fresh its data is ("synced 2 min ago") so a stale view is at least an honest one.
