# Cockpit — Unified Inbox & Dashboards prototype

A pure HTML/CSS/JS implementation of the Claude Design clickable mockup for the Unified Inbox & Dashboards concept (functional definition v0.2). No build step, no dependencies.

## Run it

Open `index.html` in a browser. That's it. (If your browser blocks the Google Fonts import when opened from disk, serve the folder instead: `npx serve .`)

## What's implemented

- **Workspaces** — Work / Atlas Copco / Personal tabs; the workspace color is the line at the top edge of the header.
- **Pages** — Today, Dormant projects, Reading, each with its own panels.
- **Dashboard** — the pinned Inbox panel on the left plus a responsive grid of action panels. Panel "···" menu (configure rule, group, remove), "+ Panel", "+ Action".
- **Triage** — the To Process list with per-row Accept-suggestion, File…, Done, Dismiss, and keyboard shortcuts (j/k move, e done, w waiting, s snooze).
- **Row swipe & drag** — on any item row, swipe left to remove the item. On the dashboard, dragging a row to the right lifts it so you can drop it into any panel at the exact position you want; a dashed placeholder shows where it will land and the other rows shift around it. Dropping outside a panel cancels. On the To Process list and the mobile swipe deck (where no panels are visible) swipe right opens a panel picker instead. Works with mouse drag or touch.
- **Item detail** — executive summary, editable AI-drafted next action, panel associations, focus horizons, status buttons, and the deep-link button that triggers the "Handled?" prompt-on-return sheet.
- **File into a panel** — the attach-and-monitor scope sheet (thread / conversation / channel).
- **Mobile** — below 720px the app reflows: swipe deck for triage (swipe left = dismiss, swipe right = file, tap = open), bottom Triage/Pages tabs, bottom-sheet detail.
- **Design notes** — the mockup's annotation drawer, kept behind the "Design notes" button.

## Deviations from the mockup

- The mockup's Desktop/Tablet/Mobile device switcher is replaced by real responsiveness: the app responds to the actual viewport width (breakpoints at 720px and 1080px).
- `--color-accent-100` is flipped to a dark step so the "Waiting" tag stays legible on the light ground (the mockup inherited a near-white value there from the dark-theme design system).

All data is in-memory sample data from the design; a reload resets everything.
