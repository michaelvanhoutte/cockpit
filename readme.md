# Cockpit — Unified Inbox & Dashboards prototype

A pure HTML/CSS/JS implementation of the Claude Design clickable mockup for the Unified Inbox & Dashboards concept (functional definition v0.2). No build step, no dependencies.

## Run it

Open `index.html` in a browser. That's it. (If your browser blocks the Google Fonts import when opened from disk, serve the folder instead: `npx serve .`)

## What's implemented

- **Workspaces** — Work / Atlas Copco / Personal tabs; the workspace color is the line at the top edge of the header.
- **Pages** — Today, Dormant projects, Reading, each with its own panels.
- **Dashboard** — the pinned Inbox panel on the left plus a responsive grid of action panels. Panel "···" menu (configure rule, group, remove), "+ Panel", "+ Action".
- **Item context menu** — right-click any row for actions. Source-app actions come first (Mail: open, reply, delete; Slack: open, reply in thread, flag/unflag; Notion: open, mark as completed; WhatsApp: open, reply; own actions: edit, mark as done), then the goal horizons, then Edit here and Move to panel. Keyboard shortcuts still work with a row selected (j/k move, e done, s snooze, Enter edit; w marks waiting when nothing is selected).
- **Goals** — single click selects a row (double click still jumps to the source; Enter opens the edit page). With a row selected, press T, W, M or Q to mark it as a goal for today, this week, this month or this quarter, or use the right-click menu. Highlighted rows get a small T/W/M/Q badge, and the collapsible read-only Goals panel at the top of a page (collapsed by default) shows everything per horizon.
- **Row swipe & drag** — on any item row, swipe left to remove the item. Dragging a row to the right lifts it so you can drop it into any panel at the exact position you want; a dashed placeholder shows where it will land and the other rows shift around it. Dropping outside a panel cancels (the placeholder snaps back home so you can see the drop will cancel). Works with mouse drag or touch.
- **Item detail** — executive summary, editable AI-drafted next action, panel associations, focus horizons, status buttons, and the deep-link button that triggers the "Handled?" prompt-on-return sheet.
- **Mobile** — below 720px the app reflows to a single column with a bottom-sheet detail view.
- **Design notes** — the mockup's annotation drawer, kept behind the "Design notes" button.

## Deviations from the mockup

- The mockup's Desktop/Tablet/Mobile device switcher is replaced by real responsiveness: the app responds to the actual viewport width (breakpoints at 720px and 1080px).
- `--color-accent-100` is flipped to a dark step so the "Waiting" tag stays legible on the light ground (the mockup inherited a near-white value there from the dark-theme design system).

All data is in-memory sample data from the design; a reload resets everything.
