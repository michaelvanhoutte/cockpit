# Offline / local-first behavior

The local copy serves **instant rendering**: the app opens and renders from a persisted local snapshot before any network call completes, and revalidates against the server once it can.

- **Reads offline:** current status, already-synced items, dashboards — the app opens and works from what it already has without a connection.
- New incoming messages only arrive when online; offline means the app still works with what it already has.

Queuing a write made offline for later, and reconciling the local copy once a source exists to reconcile against, are designed, not built — a write made offline is not currently retried or queued: see "Offline writes and reconciliation" in `docs/ideas.md`.
