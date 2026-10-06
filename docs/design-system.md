# Design system

How Cockpit looks, as against what it does (`docs/product/`). Everything here is drawn from what the code already holds — `apps/web/src/styles.css` and `packages/shared/src/domain/workspace-themes.ts` — not from a plan for it.

## Typography

**Inter Variable**, self-hosted via the `@fontsource-variable/inter` package rather than linked from a third-party origin: the app is an installed PWA that has to paint from cache on a train, and a webfont on someone else's CDN is a network request in front of first paint. Body text is 15px at a 1.55 line height.

## The fixed palette

The page, the top bar, the agents' dock and every list's well are the same in every Workspace. Only the dashboard band, the accent and the logo's dot follow one (below), which is what lets a Workspace's colour be chosen freely without touching legibility anywhere else.

- **Ink** — the Conselit brand's: `ink-strong` `#16181d` (headings), `ink` `#3a3f4b` (body), `ink-soft`, `ink-faint`, on the neutral surfaces. `shade`, the same `#16181d`, is what hairlines, dimming and shadows are at low alpha; nothing is black.
- **Neutral surfaces** — `surface`, and `ground`: the page is warm grey `#f3f3f1` inside a Workspace (stored with it), and `ground` `#f4f4f2` where no Workspace paints it, such as the logon page.
- **Category colours** — the brand's six (`cat-slate`, `cat-teal`, `cat-amber`, `cat-green`, `cat-violet`, `cat-grey`), each with a `-tint` for hover and selected fills and a `-light` for use on the chrome. Status colours map onto them where the hue is close rather than keeping near-duplicates.
- **Accent** — `accent`, `accent-deep`, `accent-soft`, `accent-tint`: headings, buttons, focus rings and type labels. `on-accent` is the text on a fill of `accent`, and `accent-hover` that fill under the pointer. The shell sets them from the Workspace, so menus and windows opened over the page follow it too; outside a Workspace they are the default theme's.
- **Due / overdue** — `due`, `due-soft`, `due-ink`, `due-deep`, `over`, `over-deep`: the amber and red of a deadline pill, never of a whole row. The pill steps up as the date closes — an outline in `due` with `due-ink` text, a `due-soft` fill, solid `due` with `due-deep` text, then `over-deep` with white text once passed — each at least 4.5:1 on what it is written on. `over-deep` exists because the swipe reveal also fills a band with `over` and writes a word inside it, and white on `over` itself falls short of readable at that size.
- **Status** — one colour per Item status (`to-process`, `task`, `waiting`, `delegated`, `snoozed`, `reference`), always paired with the word beside it: colour alone cannot separate six statuses, and cannot be read by a screen reader at all.

## Workspace themes

A Workspace theme is designed as a set: **tint** (the saturated colour: the accent, the tab dot, the logo's dot), **bar** (the dashboard band, a deep shade of the tint), **deep** (the tint where it is text), **onAccent** (the text on a fill of the tint) and the two neutrals **ground** and **header**, which are the same in all eight. Near-white text (`chrome-ink`) is what is drawn on the band, never themed.

**Every band and deep shade is designed per theme, not mixed**, and held by a test to: near-white text on the band at least 4.5:1, `deep` as text on the page and on a well at least 4.5:1, `deep` on the selected chip's fill (the tint at 14% over white) at least 4.5:1, `onAccent` on the tint at least 4.5:1, and the tint lifted 30% towards white at least 3:1 as the logo's dot on the top bar. A band is the tint darkened 20% where that already reads, and further where it does not (Amber, Olive, Cyan).

**Text on an accent fill is dark ink (`#16181d`) on the five light themes (Terracotta, Teal, Amber, Cyan, Olive) and white on Violet, Blue and Magenta**, because white on those five falls under 4.5:1. Every filled button writes `text-on-accent`, never `text-white`. **A pressed toggle (a filter option) is filled with `accent` and written `text-on-accent`; an unpressed one has no fill, so on and off differ by fill, not tint. A field holding a value wears a 2px `accent` border.** On the five, the hover fill is the tint mixed 15% towards white, since `deep` is darker than ink can be read on. `deep` and `onAccent` are not stored, so changing either rewrites no Workspace.

The palette is eight designed sets, handed out to new Workspaces in this order. `header` and `ground` are `#2d2e35` and `#f3f3f1` in every row:

| Theme | Tint | Bar | Deep | On accent |
|---|---|---|---|---|
| Violet | `#6f62b5` | `#594e91` | `#6b5eae` | white |
| Blue | `#3a72c8` | `#2e5ba0` | `#3568b7` | white |
| Terracotta | `#c06a45` | `#9a5537` | `#9e5739` | ink |
| Teal | `#3f8f78` | `#327260` | `#347663` | ink |
| Magenta | `#a8548c` | `#864370` | `#9b4e81` | white |
| Amber | `#b58a2f` | `#866623` | `#886823` | ink |
| Cyan | `#4f8fa8` | `#3f7286` | `#3f7286` | ink |
| Olive | `#7d8f3f` | `#637132` | `#647232` | ink |

A Workspace is never assigned colours outside this table: a stored set that is not exactly a row of it, including every set stored before the page went neutral, is drawn in the theme its tint belongs to, or the default (Violet) where the tint is not in the table. Nothing stored is rewritten.

## Chrome

- **Top bar and agents' dock** — one soft graphite gradient, `#2d2e35` at the top to `#16181d`, in every Workspace. The agents sit in a recessed tray in the dock, each tile with a 10px round dot in its colour. A hide control (▼) leads the dock; while the dock is hidden, a strip as tall as a button (▲ Agents) stays in the same spot at the bottom edge and opens it again. A row that takes an Agent being dragged wears a faint `accent-tint`; the one under the pointer wears a full `accent-tint` and a solid 2px `accent` outline inset on the row.
- **Dashboard band** — the Workspace's `bar`. The selected Workspace tab is filled with it and runs down into it; unselected dashboard tabs are near-white; the selected one is filled with the page. The Inbox's heading is a rounded tab in the page's colour with a strip of band above it.
- **Logo** — four rounded squares in a two-by-two grid, the fourth in the Workspace's tint and the other three in `chrome-ink` (`components/Logo.tsx`), beside the name and gone with it below `sm`. The favicon and installed-app icon are the same mark on a graphite tile with the default violet fourth square. A C is Conselit's own mark and is never drawn.
- **Credit** — "© 2026 Conselit · conselit.be" (the years run to the current one), linking www.conselit.be in a new tab: faint under the logon page's card, and the last profile-menu entry below a divider.
- **Panel frame** — each panel wears a faint 1px dotted frame around its heading and list, the list inset 4px.

## Surfaces

- **Well** — a list sunk into the sheet: no radius, no border, a shallow inner shadow along the top edge, mixed from the page's `ground` lifted towards white. The sheet stays one surface and the list is a hollow in it rather than a card on it; a header above it sits up on the sheet, and only the list goes down.
- **Well (Inbox)** — the same hollow lifted a little further towards white, marking the one column that is the same on every screen of a Workspace. Neutral like the rest: no hollow carries a hue.
- **Milled** — a control that reads as a surface rather than a filled rectangle: a faint vertical gradient over whatever background colour it already has, and a one-pixel highlight along its top edge. Additive: it paints over a control's own Tailwind background colour rather than replacing it, meant to be felt rather than seen.
- **Bottom sheet** — what a phone opens in place of a bar of controls (the Dashboard filter): slides up from the bottom over a dimmed scrim (`bg-shade/40`), `surface` fill, rounded top corners (`rounded-t-2xl`), a grab handle, a header with its action at the right, one labelled row per control with the label in a fixed 6rem column, and a full-width accent **Done**. A swipe down on the handle and header closes it. Its pinned counterpart, the one-row summary line, sits in the bar's own outline with the pressed-style pills and an *Edit* in `accent-deep`.
- **Elevation** — a two-step shadow scale (`panel`, `raised`) for what genuinely floats: a dialog, a menu, the row lifted under a drag. A Panel itself is not elevated — its list is sunk (`well`, above) rather than raised, so nothing on a Dashboard advances towards you. Floating layers stack in one order: page content, then pinned bars (the Dashboard filter bar, the selection bar), then menus, submenus and dialogs with their dimming (`z-floating`), then the undo toast and the "Updating" notice. A new pinned element goes below `z-floating`; a new floating layer takes it.

## Field chips

On an Item's phone page the fields are one wrapping row of pill chips, 36px tall so a thumb hits them, 8px apart. **A field with nothing set is an outline in `ink-faint` carrying its own name**, so the row reads as what can still be set; **a set one is filled and says its value**: Type in `accent-tint` with `accent-deep` text, Status in a faint shade with `ink`, Priority in its own `priority-*` fill with white text, and Due as the row's deadline pill (the same fills as above, a plain shade when the date is over a week off). **+ Attach** is always an outline. A chip opens its picker as a menu with the current choice ticked; Due opens a small sheet of *Today*, *Tomorrow*, *+7d*, the date picker and *Clear*.

## The dark Car view

Switched on from inside the Car view only, for capturing at night; no other screen has a dark appearance. **Dimmed, not inverted**: a near-black ground, grey text, each surface one notch lighter. The top bar is unchanged. The tokens are `night*` in `styles.css`; every text is at least 4.5:1 on what it is drawn on (held by a test), except the set-apart placeholder and provisional words at 3:1.

| Where | Value |
|---|---|
| ground (page, shell edge) | `night` `#111216`; the band under the tabs `night-band` `#17181c` |
| words card, footer controls, Write \| Car switch | `night-card` `#1a1b20`, border white at 5% (card) or 10% (controls) |
| status line and card text | `night-ink` `#a9acb4`; an error `night-over` `#d0716a` |
| footer text, Capture heading, tag, switch text | `night-ink-soft` `#868993`; the lit side of the switch is white at 10% with `night-ink` |
| placeholder and provisional words | `night-faint` `#6b6e78` |
| round button | `accent-deep` idle and captured, `over-deep` listening, no shadow, brightness 70%, icon `night-icon` `#c9cbd1`; the listening ring is `over` at 15% |

## One token set

Every colour, radius and shadow in the web app is a name from `styles.css`: no hex, `rgb(`, `black`, or arbitrary Tailwind colour, radius or shadow value is written anywhere else, and `scripts/lib/theme-tokens.test.mjs` fails on one. A value the theme cannot name at build time arrives as a runtime variable (`bg-[var(--tab-on)]`). A value with no token gets a named one. Font sizes are outside this.

## Radius

Three steps — `sm` (4px), `md` (10px), `lg` (14px) — used by control size rather than by component identity.
