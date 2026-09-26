# Inbox

**The Inbox is every open Item filed on no Panel**, scoped to the current Workspace — not a Panel with rows of its own, but the absence of a filing. That is what makes filing an Item the thing that takes it out of the Inbox, and it is why an Item can be moved back there: moving an Item to the Inbox is taking it off every Panel.

**Where it sits: beside the Dashboards, not among them.** Everything else flows out of it — it is read while working on a Dashboard and dropped into while looking at something else — so it is not one more view to switch to. Where there is room, it is a column down the left of every screen inside a Workspace, about a fifth of the width with a floor and a ceiling so it stays readable at 1280px and does not swallow a very wide screen; it scrolls on its own and so does the Dashboard beside it. Every screen inside a Workspace has it, including the ones a form or the Types window opens over. On a phone, where a fifth of the width is about ninety pixels, the Inbox is a tab pinned at the left of the bar opening a screen of its own — and it keeps that address at every width, so a link made on a phone still works on a desktop. **It can be collapsed.** A `�` at the left of its heading collapses the column into a chip at the left of the Dashboard bar reading its name, its count and `�`, and the Dashboard takes the whole width; pressing the chip, or `I` from anywhere but a field, a menu or a window, brings the column back at the width it had. A row held on the chip opens the Inbox so it can be dropped into it, and dropping on the chip itself does nothing. The choice is remembered in this browser for every Workspace, like the column's width, which can be dragged by hand. A phone has no column, so nothing changes there.

Its name and the number in it head the column from the Dashboard bar, in the leftmost slot of it, so the bar is a row of headings and the Inbox is the leftmost — which is what says the Inbox belongs to the Workspace rather than to a Dashboard. On a phone there is no column to head, and the screen the tab opens carries the name itself.

**Capture has one way in: the header's Capture tab, and `C`.** The Inbox has no note box of its own. At a desk both open Capture as a window over the screen you are on — a note of several lines, the Types as chips, a row of Workspaces, and what has just been captured under it — and Escape puts you back where you were, the note already in the Inbox beside it. On a phone both open the Capture page, where capture is the primary use. `C` works anywhere inside Cockpit except while typing in a field, while a menu or window is open, or with Ctrl, Alt or ⌘ held; the tab's tooltip reads *Capture (C)*.

**Where starts on the Workspace you are in**, in the window and on the page, and on *Any workspace* only when Capture is reached from outside one — a typed `/capture`, or the installed app's shortcut. A different Workspace chosen in the window holds until the window closes, so several notes for one customer cost one choice; reopening starts on the current Workspace again. A note left on *Any workspace* waits in every Workspace's Inbox until somebody says where it belongs; the Workspace it was captured *from* is recorded either way. `/capture` is the page at every width, because a link and the installed app's shortcut open it; the window has no address of its own, like the Types window.

Processing an Item today means one of:

- **Mark it done** — which takes it off every list, saying when.
- **File it on a Panel** — which is what takes it out of the Inbox, and the one thing that does. Every Item's own menu carries **Move to…**, opening a picker of every Panel in the Workspace with the Dashboard you are on first, the three Panels most recently filed into above it, and the Inbox among the targets.
- **Delete/Dismiss** — which is reversible for as long as the bar offering it is on screen. A dismissed Item is kept rather than erased, and undismissing it brings it back, so putting it back is the same change made the other way.

Reading, replying, flagging and associating an Item are designed, not built — reading and replying need something to read (no connector exists yet), and associating needs a view onto the Associations that already exist in the schema: see "Sources to connect" and "Associations" in `docs/ideas.md`.

Filing it, finishing it or dismissing it takes an Item out of the Inbox; it stays reachable through the Panels holding it.

**Gestures:** **swipe left dismisses, swipe right opens the picker** — the same picker **Move to…** opens, so filing is one gesture on a phone and the same question either way. One meaning per direction, in every list rather than only the Inbox: the same swipe cannot mean two things depending on which list it is in, so removing an Item from one Panel stays in the menu. A swipe that stops short puts the row back, and one that is mostly vertical is the list scrolling and does nothing at all. **A swipe is a touch gesture**: on a desktop the same actions are the menu.

**The row names the action it would take, in the strip it uncovers**, from the first pixel it moves rather than from the threshold — which direction means what is the part a thumb cannot see, and by the time the threshold is reached the direction has already been chosen. A mark says it as soon as there is room for one and the word joins it once the strip is wide enough to hold the whole of it, a word half off the edge being worse than none; the words are the menu's own, **Move to…** and **Dismiss**, so the two ways to an action are not two things to learn. Past the threshold the strip fills with colour to say that letting go now takes it. The row **cannot name an action the release would not take**: what it says and what it does are one answer, not two.

**Open question:** does "delete" mean delete only here, or also archive/delete in Gmail/Slack? See "Open decisions" in `docs/functional-definition.md` — the single biggest behavioral decision, and one that waits on a connector existing at all.

## How an Item reaches a box — must it pass through the Inbox first? (undecided)

The reframing that makes this tractable: **"in the Inbox" and "shown in a box" are two independent states, not two ends of one pipeline.** Associations are many-to-many and being finished with an Item is separate (see "Item + Association model" in `docs/product/items.md`), so an Item can be in either, both or neither, and "passes through the inbox first" is a per-source default rather than an architecture.

**Model A — Inbox-first (manual triage).** Everything lands in the Inbox; nothing appears in a box until deliberately filed there. *Pro:* one point of control. *Con:* obvious items still need manual routing.

**Model B — Direct routing by rule.** Rules send certain items straight to a box: "Slack messages in #customer-1 → Customer 1's board", "@mentions on a project → that project's box", "anything I star → its box". *Pro:* far less busywork. *Con:* items appear without a review step, so they need an "unseen" dot or a per-rule "also show in Inbox" toggle.

**Inside Model B, passive vs active capture:** being tagged or @mentioned is *passive* — route it **and** flag as unseen; deliberately saving a message is *active*, a strong intentional signal that should skip the Inbox entirely.

**Recommended lean (a hybrid).** Inbox by default for anything with no matching rule, plus per-source/per-channel routing rules so obvious and actively-saved items land directly in a box, optionally marked "unseen". Decision still open, and moot until a connector exists to route from.

## Swipe-right — settled

**Swipe-right opens the picker**, the same one **Move to…** opens. Filing is what an Inbox row most often needs and the picker is where the decision already lives, so a phone gets to it in one gesture rather than three taps.

**One meaning per direction, at one distance.** The other candidates — a quick process sheet, a wake date, done — were going to be told apart by how far the swipe went, and that is what the gesture cannot spare: it is already competing with the list scrolling under the same thumb, so the difference between a short swipe and a long one is not a difference a hand can be relied on to make. They stay in the row's menu, where there is no threshold to miss.
