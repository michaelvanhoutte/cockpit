# Design system

How Cockpit looks, as against what it does (`docs/product/`). Everything here is drawn from what the code already holds — `apps/web/src/styles.css` and `packages/shared/src/domain/workspace-themes.ts` — not from a plan for it.

## Typography

**Inter Variable**, self-hosted via the `@fontsource-variable/inter` package rather than linked from a third-party origin: the app is an installed PWA that has to paint from cache on a train, and a webfont on someone else's CDN is a network request in front of first paint. Body text is 15px at a 1.55 line height.

## The fixed palette

Panels, rows and controls keep one neutral/accent palette wherever they are drawn; only the chrome recolors per Workspace (below). This is what lets a Workspace's colour be chosen freely without touching legibility anywhere else.

- **Ink** — `ink`, `ink-soft`, `ink-faint`: body text, on the neutral surfaces.
- **Neutral surfaces** — `surface`, `ground`.
- **Accent** — `accent`, `accent-deep`, `accent-soft`, `accent-tint`: the one hue used for selection and emphasis outside a Workspace's own tint.
- **Due / overdue** — `due`, `due-soft`, `due-ink`, `due-deep`, `over`, `over-deep`: the amber and red of a deadline pill, never of a whole row. The pill steps up as the date closes — an outline in `due` with `due-ink` text, a `due-soft` fill, solid `due` with `due-deep` text, then `over-deep` with white text once passed — each at least 4.5:1 on what it is written on. `over-deep` exists because the swipe reveal also fills a band with `over` and writes a word inside it, and white on `over` itself falls short of readable at that size.
- **Status** — one colour per Item status (`to-process`, `task`, `waiting`, `delegated`, `snoozed`, `reference`), always paired with the word beside it: colour alone cannot separate six statuses, and cannot be read by a screen reader at all.

## Workspace themes

A Workspace theme is four colours designed together, not four independent choices: **tint** (the saturated one, for the tab dot and the selected tab), **header** (the bar across the top, the deepest surface), **bar** (the strip the Dashboard tabs sit on, one step lighter than `header`), and **ground** (the sheet behind the panels, the lightest). The two chrome surfaces (`header`, `bar`) are near-black in the theme's own hue; `ground` is near-white in it. Text drawn on the chrome is one fixed light set in every theme, never themed itself, so a Workspace's colour never has to be checked against a second text palette.

The palette is eight designed sets, handed out to new Workspaces in this order:

| Theme | Tint | Bar | Ground | Header |
|---|---|---|---|---|
| Violet | `#6f62b5` | `#211d37` | `#edebf7` | `#18152b` |
| Blue | `#3a72c8` | `#1d2737` | `#ebf0f7` | `#151e2b` |
| Terracotta | `#c06a45` | `#37251d` | `#f7efeb` | `#2b1c15` |
| Teal | `#3f8f78` | `#1d372f` | `#ebf7f3` | `#152b24` |
| Magenta | `#a8548c` | `#371d2e` | `#f7ebf3` | `#2b1523` |
| Amber | `#b58a2f` | `#372f1d` | `#f7f3eb` | `#2b2415` |
| Cyan | `#4f8fa8` | `#1d3037` | `#ebf4f7` | `#15252b` |
| Olive | `#7d8f3f` | `#31371d` | `#f4f7eb` | `#262b15` |

A Workspace is never assigned colours outside this table: a stored theme not in it is drawn in the default (Violet) rather than in what it stores.

## Surfaces

- **Well** — a list sunk into the sheet: no radius, no border, a shallow inner shadow along the top edge, mixed from the Workspace's own `ground` lifted towards white. The sheet stays one surface and the list is a hollow in it rather than a card on it; a header above it sits up on the sheet, and only the list goes down.
- **Well (Inbox)** — the same hollow, mixed from the Workspace's `ground` towards its accent rather than towards neutral ink: a fraction more colour than the panels beside it, marking the one column that is the same on every screen of a Workspace.
- **Milled** — a control that reads as a surface rather than a filled rectangle: a faint vertical gradient over whatever background colour it already has, and a one-pixel highlight along its top edge. Additive: it paints over a control's own Tailwind background colour rather than replacing it, meant to be felt rather than seen.
- **Elevation** — a two-step shadow scale (`panel`, `raised`) for what genuinely floats: a dialog, a menu, the row lifted under a drag. A Panel itself is not elevated — its list is sunk (`well`, above) rather than raised, so nothing on a Dashboard advances towards you.

## Radius

Three steps — `sm` (4px), `md` (8px), `lg` (14px) — used by control size rather than by component identity.
