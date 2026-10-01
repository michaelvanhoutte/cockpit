# Offline / local-first behavior

The local copy serves **instant rendering**: the app opens and renders from a persisted local snapshot before any network call completes, and revalidates against the server once it can.

- **Reads offline:** current status, already-synced items, dashboards — the app opens and works from what it already has without a connection.
- New incoming messages only arrive when online; offline means the app still works with what it already has.

**Capturing never waits on the connection.** Pressing Capture keeps the note, its files and the time it was captured on this device and empties the box at once; Cockpit sends it in the background, oldest first, as soon as a connection gets through — on opening, on reconnecting, on coming back to the tab, on the next capture, after anything else reaches the server, and every half-minute to a minute in between. The Item says when it was captured, not when it arrived.

- **Just captured** shows each capture's state, and survives a reload: *Waiting to send*, the time once it lands, or *Not sent* with the server's reason and **Put back**, which returns the note and its files to the box. A capture is *Not sent* only when the server refuses it — its Workspace or Type deleted meanwhile; no connection, a timeout, a server error or an expired sign-in keep it waiting.
- **The Capture tab carries a count** while anything has not landed, a refused one included.
- **A waiting capture belongs to whoever captured it.** It is sent and shown only while they are signed in, an expired sign-in loses nothing, and only signing out deletes it — after asking, when anything is waiting ("2 captures haven't been sent and will be lost").
- **Where the browser cannot keep it** — a private window, storage refused — capture sends at once, and with no connection says so and leaves the note in the box.

There is no switch for working offline: capture never waits, so there is nothing for one to save. Every other change still needs the connection, including a Panel's own **Add an item**, which files what it makes; queuing those, and reconciling the local copy once a source exists to reconcile against, are designed, not built: see "Offline writes and reconciliation" in `docs/ideas.md`.
