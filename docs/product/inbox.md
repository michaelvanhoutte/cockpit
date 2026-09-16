# Inbox

## 5. The Inbox and the triage flow *(iteration 2)*

*Iteration 1 has no in-app inbox: flagging at the source is the capture mechanism and those items route straight to the panels — the "active capture" case of Model B ("How an Item reaches a box", below). Iteration 2 adds the Model A triage queue for everything not pre-flagged.*

**The Inbox is every open Item filed on no Panel**, scoped to the current Workspace — not a Panel with rows of its own, but the absence of a filing. That is what makes filing an Item the thing that takes it out of the Inbox, and it is why an Item can be moved back there: moving an Item to the Inbox is taking it off every Panel.

**Where it sits: beside the Dashboards, not among them** ("Show the Inbox beside the dashboards instead of as a tab", issue 117). Everything else flows out of it — it is read while working on a Dashboard and dropped into while looking at something else — so it is not one more view to switch to. Where there is room, it is a column down the left of every screen inside a Workspace, about a fifth of the width with a floor and a ceiling so it stays readable at 1280px and does not swallow a very wide screen; it scrolls on its own and so does the Dashboard beside it. Every screen inside a Workspace has it, including the ones a form or the Types window opens over. On a phone, where a fifth of the width is about ninety pixels, the Inbox is a tab pinned at the left of the bar opening a screen of its own — and it keeps that address at every width, so a link made on a phone still works on a desktop. Hiding and hand-resizing it are not part of this yet.

Capture is its first row ("Show one Inbox per workspace, with capture at the top of it", issue 89): writing something down and seeing where it landed are the same place. Its name and the number in it head the column from the Dashboard bar, in the leftmost slot of it, so the bar is a row of headings and the Inbox is the leftmost — which is what says the Inbox belongs to the Workspace rather than to a Dashboard. On a phone there is no column to head, and the screen the tab opens carries the name itself.

**Capture is also a screen of its own**, reached from the header and belonging to no Workspace ("Capture Page", artboards 2a and 2c): a note of several lines, the Types as chips, and a row of Workspaces that starts on *Any workspace*. Left there, the note waits in every Workspace's Inbox until somebody says where it belongs; the Workspace it was captured *from* is recorded either way. What it has just captured is listed under the box for as long as the screen is open. The Inbox's own row stays the narrow way in - it has a column to fit in, and asks the same capture in one line.

Processing an Item means one or more of:

- **Read and respond** — the content is readable in the app, and where the source supports it you can react or reply from here; otherwise the deep link ("action cards", below) takes you to the source.
- **Flag for follow-up** — it becomes a tracked follow-up on the dashboards, exactly as if flagged at the source.
- **Associate it** — tag it to a Person, Project and/or Topic, which is what puts it in the right panels.
- **Mark it done** — which takes it off every list, saying when.
- **File it on a Panel** — which is what takes it out of the Inbox, and the one thing that does. Every Item's own menu carries **Move to…**, opening a picker of every Panel in the Workspace with the Dashboard you are on first, the three Panels most recently filed into above it, and the Inbox among the targets.
- **Delete/Dismiss** — which is reversible for as long as the bar offering it is on screen ("Undo what just happened", issue 144). A dismissed Item is kept rather than erased, and undismissing it brings it back, so putting it back is the same change made the other way.

Filing it, finishing it or dismissing it takes an Item out of the Inbox; it stays reachable through the Panels holding it, through its associations, and through an optional "All items" view.

**Gestures** ("Swipe an inbox row right to file it, left to dismiss it", issue 145): **swipe left dismisses, swipe right opens the picker** — the same picker **Move to…** opens, so filing is one gesture on a phone and the same question either way. One meaning per direction, in every list rather than only the Inbox: the same swipe cannot mean two things depending on which list it is in, so removing an Item from one Panel stays in the menu. A swipe that stops short puts the row back, and one that is mostly vertical is the list scrolling and does nothing at all. **A swipe is a touch gesture**: on a desktop the same actions are the menu, and a Panel is reached by dragging the row into it.

**The row names the action it would take, in the strip it uncovers**, from the first pixel it moves rather than from the threshold — which direction means what is the part a thumb cannot see, and by the time the threshold is reached the direction has already been chosen. A mark says it as soon as there is room for one and the word joins it once the strip is wide enough to hold the whole of it, a word half off the edge being worse than none; the words are the menu's own, **Move to…** and **Dismiss**, so the two ways to an action are not two things to learn. Past the threshold the strip fills with colour to say that letting go now takes it. The row **cannot name an action the release would not take**: what it says and what it does are one answer, not two.

**Open question:** does "delete" mean delete only here, or also archive/delete in Gmail/Slack? See "Open decisions", below — the single biggest behavioral decision.

### 5.1 How an Item reaches a box — must it pass through the Inbox first? (undecided)

The reframing that makes this tractable: **"in the Inbox" and "shown in a box" are two independent states, not two ends of one pipeline.** Associations are many-to-many and being finished with an Item is separate ("Item + Association model", above), so an Item can be in either, both or neither, and "passes through the inbox first" is a per-source default rather than an architecture.

**Model A — Inbox-first (manual triage).** Everything lands in To Process; nothing appears in a box until deliberately filed there. *Pro:* one point of control. *Con:* obvious items still need manual routing.

**Model B — Direct routing by rule.** Rules send certain items straight to a box: "Slack messages in #customer-1 → Customer 1's board", "@mentions on a project → that project's box", "anything I star → its box". *Pro:* far less busywork. *Con:* items appear without a review step, so they need an "unseen" dot or a per-rule "also show in Inbox" toggle.

**Inside Model B, passive vs active capture:** being tagged or @mentioned is *passive* — route it **and** flag as unseen; deliberately saving a message is *active*, a strong intentional signal that should skip the Inbox entirely.

**Recommended lean (a hybrid).** Inbox by default for anything with no matching rule, plus per-source/per-channel routing rules so obvious and actively-saved items land directly in a box, optionally marked "unseen". Decision still open.

### 5.2 Swipe-right — settled

**Swipe-right opens the picker**, the same one **Move to…** opens ("Swipe an inbox row right to file it, left to dismiss it", issue 145). Filing is what an Inbox row most often needs and the picker is where the decision already lives, so a phone gets to it in one gesture rather than three taps.

**One meaning per direction, at one distance.** The other candidates — a quick process sheet, a wake date, done — were going to be told apart by how far the swipe went, and that is what the gesture cannot spare: it is already competing with the list scrolling under the same thumb, so the difference between a short swipe and a long one is not a difference a hand can be relied on to make. They stay in the row's menu, where there is no threshold to miss.
