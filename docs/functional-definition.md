# Unified Inbox & Dashboards — Functional Definition (v0.7)

*Working title: TBD. Owner: Michael. Status: draft for refinement.*

## 1. Purpose

One application that aggregates what currently lands in many separate apps (email, Slack, Notion, later Linear, Calendar, Chrome, YouTube), so no app has to be checked individually. It does two jobs, delivered as two iterations (§1.1):

1. **Overview** (iteration 1): configurable dashboards of movable, titled panels surfacing everything flagged for follow-up, organized by project, person, topic and priority.
2. **Process** (iteration 2): a unified triage inbox where new items from every source arrive as "things to deal with", and each one gets read, reacted to, or flagged for follow-up (which feeds the iteration 1 overview).

The goal is to replace today's manual Notion setup with something faster to scan and triage, structured around *your* contexts (work, home, each customer, each project) rather than around which app a message came from.

### 1.1 Two iterations

The split follows where the pain is largest: forgetting things already decided on hurts more than reading messages in separate apps.

**Iteration 1: follow-up tracking ("never lose a flagged item").** Only explicitly marked items are ingested — an email flagged in Gmail, a Slack message saved for later or an actionable @mention, a Notion action or comment assigned to me — and shown on the dashboards. The source apps remain where messages are read and answered. This needs the container hierarchy and Item/Association model (§4), dashboards with Panels and action cards (§6), Focus horizons and deadline colors (§7), AI next-action labels and suggested associations (§8), read-only connectors limited to flagged items (§9), and reconciliation so items completed or removed at the source disappear here too (§10.1). Fast capture (issue 2, §2) belongs here too: a quick idea is a follow-up item without an external source.

**Iteration 2: unified inbox ("read and process everything here").** All emails and messages become readable in one place, where each item can be read, replied to, or flagged to handle later. Adds full-firehose ingestion, the To-Process triage flow (§5), notification-email routing (issue 6, §2), and the panels that need all mail rather than only flagged mail: Payments due (issue 7) and the Reading digest (issue 8).

In one sentence: iteration 1 tracks what was already flagged; iteration 2 brings the flagging, reading and replying into the app.

## 2. Problems this product must solve

The concrete pains with today's way of working (a manual Notion board beside each tool). Every design choice below should be checked against them. Each is tagged with the iteration (§1.1) that addresses it.

1. **No single overview of everything to follow up on.** *(Iteration 1.)* The main problem. Items needing a reply are spread across tools, and the only overview today is manual double work — adding a Notion item so a Slack message is not forgotten. (Addressed by the Item model, §4.2, with flagged items routing straight to the dashboards; the full triage flow, §5, follows in iteration 2.)
2. **Capturing a simple idea takes too much time.** *(Iteration 1.)* Logging a quick idea costs too much friction, which is why `c:\github\task-creator` was built as a stopgap; it should merge into this project as the fast capture path (§4.2).
3. **Categorizing items is too much work, so it doesn't happen.** *(Iteration 1.)* The result is one Notion block holding a long mixed pile that grows until items get lost. Structure is wanted, but structuring must cost almost no effort. (Addressed by AI-suggested associations, §8.)
4. **"Today / this week" markers silently rot.** *(Iteration 1.)* Unfinished items keep their markers, so days later things are still colored "today" with a deadline in the past. Priority markers must be date-anchored and escalate on their own. (Addressed by Focus horizons, §7.)
5. **The overview must not become a mess: some items group, others must stay individual.** *(Iteration 1.)* Several Notion comments about one project probably belong together as one entry; five MT-meeting actions each about a different project must stay separate. What drives that is undecided — open decision #14 (§12).
6. **Automated notification email drowns out the mail that matters.** *(Iteration 2.)* Notion updates, meeting invites, GitHub activity and monitoring digests flood the inbox, but disabling them at the source loses information the app may want as a signal. So the noise must not clutter the inbox by default while staying available on demand and as machine-readable input. Routing is open decision #15 (§12).
7. **No overview of payments still to make.** *(Iteration 2.)* Invoices, payment requests and renewal notices arrive mixed in with everything else. One overview should list every email-derived item involving an unmade payment, with amount and due date where extractable, dropping off once paid. (Addressed by a Payments panel, §6, fed by AI classification, §8; detecting "paid" is open decision #16.)
8. **Technology and research email is unreadable at its volume, so none of it gets read.** *(Iteration 2.)* Reading this class item-by-item is the wrong model. Instead: a panel of highlights distilled from those emails on the topics I care about, so each day shows a short selection worth reading and the rest can be ignored. Unlike issue 6's notification noise, this mail is content to consume, not a signal. (Addressed by a Reading digest panel, §6, fed by topic extraction, §8; open decision #17.)
9. **A local copy is needed for speed and offline use, but it can drift out of sync.** *(Iteration 1, growing in iteration 2.)* The main driver is rendering speed — a dashboard cannot query Gmail, Slack and Notion live on every refresh — with offline viewing largely a byproduct. The hard problem is staleness: showing work that no longer exists destroys trust in the overview faster than missing items do. Changes at the source (removed, completed, edited) must flow back without double bookkeeping. (Addressed by reconciliation, §10.1; cadence is open decision #18.)

## 3. Decisions already made

- **Delivery — two iterations.** Iteration 1 tracks items flagged at the source; iteration 2 adds the read-and-process inbox on top (§1.1). The data model does not change between them.
- **Audience — personal-first, SaaS-ready.** Built for one person first, with a data model, tenancy and auth that could become a multi-tenant product without a rewrite. **There is now more than one User**, each in an Account of their own ("Sign in by picking a name, each user in their own account", issue 86). A passwordless list of names is an identity selector, not an authentication control, and it is the only thing in front of a deployed environment; what it does mean is that the tenancy the schema always carried is exercised rather than assumed. Never hard-code how many Accounts exist into the schema.
- **Offline — local-first.** Syncing happens online, but the app must open, show current status, read synced items and triage them without a connection; offline changes queue and reconcile on reconnect. Per issue 9 (§2), instant rendering is the primary purpose and offline use should fall out of the cache design rather than drive machinery of its own.
- **Inbox — triage queue.** The Inbox lists what has arrived and not been dealt with, not a permanent mirror of every message. **What decides is filing**: an Item filed on a Panel has left the Inbox and is visible in every Panel holding it ("Panels hold the items filed into them, and the Inbox holds the rest", issue 36). What an Item *is* — its Type — is separate from which list it is in.
- **v1 sources — Gmail, Slack, Notion.** Linear, Google Calendar, Chrome (bookmarks/downloads) and YouTube (saved videos) are later phases.

## 4. Core concepts and terminology

Everything is built from a **container hierarchy** and an **item model**.

### 4.1 Container hierarchy (resolves "dashboard vs workspace")

**Workspace** — the top-level context and the privacy boundary (*Work*, *Personal*, *Home*, *Customer 1*). It controls **which source accounts are connected and visible**, so private email is invisible while in *Work*: scoping rather than filtering after the fact.

Each Workspace has a **color identity of four colors**: a saturated tint, and three surfaces stepping from deepest to lightest — the header bar, the strip the Dashboard tabs sit on, and the page ground behind the panels. The tab you are on is filled with the surface below it and joins onto it, so the container hierarchy reads as depth rather than as two rows of pills on one fill, and the tint marks it. Switching Workspace repaints all four. Nothing else moves — cards, rows, controls and text keep the fixed neutral and accent palette — which is what lets the colors be chosen freely. They are picked as a set from a fixed palette on the workspace settings page (open decision #13).

Workspaces are made, renamed, ordered and deleted from the workspace settings page, where each is a row with its own menu. **The box for making one sits above the list**, so the way to make a Workspace does not recede as the list grows. A name is required, stored trimmed, one line of at most 60 characters, and unique among live Workspaces whatever the capitalization. **Deleting a Workspace keeps everything that was in it**: its Items stay filed against it, because the router learns from the whole history of where things were filed (routing that learns from past decisions, "What the model reads: the whole history, no retrieval"). The name becomes available again. The last Workspace can be deleted, and the app then opens on the page that makes one.

**The order of the rows on that page is the order of the tabs across the top, left to right** ("Reorder workspaces", issue 31). A new Workspace goes last, after every Workspace the account has ever had; deleting one closes the gap. Two ways to move one, neither the lesser: the grip at the left of a row drags it, and **Move up** / **Move down** in the row's menu take it one step. The menu is the only way a keyboard has and the comfortable way on a phone, so on the first row **Move up** stays in the menu, unavailable, saying *It is already the first*, rather than disappearing. A move shows itself before the server agrees — the one change on that page that does not wait, so a second move can follow a first and a dropped row does not snap back for a round trip. If it is refused, because a Workspace was made or deleted in another tab, the row goes back and says so.

**Deleting anything asks first, in a dialog, and the row it was asked from does not change** ("Ask before deleting in a dialog, from the row's own menu", issue 116). The question names what is going and what goes with it — for a Workspace, how many Items stop being visible — and offers Cancel and Delete in one fixed order everywhere, so the control under the pointer never changes meaning between the press that asks and the press that answers. Escape and Cancel are the two ways to say no; pressing outside is deliberately not one. Focus returns to the row it was asked from. Nothing is sent until Delete is pressed, and a Workspace's Delete waits for the count it is asking about, though a count that could not be read at all lets it through rather than trapping you. A refusal keeps the dialog open and says why. Renaming is not destructive and stays in the row.

**Editing more than one field at a time happens in a form, and a form is a modal with a route of its own**, dimmed behind ("Edit an item's title and description on a form of its own", issue 159, which is the first). The URL says what is open, so the back button closes it and a link opens it — which is what a question does not need and does not get: a question is a small centred dialog with nothing to link to. Nothing is written until **Save**, which sends only the fields that actually changed, so leaving one untouched cannot overwrite an edit made elsewhere. Cancel, Escape and pressing outside all close the form and discard what was typed, without asking, because Cancel means cancel. Deliberately unlike the deleting rule above: a delete asks because there is one way to say yes and no way back, while a form has Save sitting in it, unpressed.

**Dashboard** — a named view *inside* a Workspace, switched between like tabs. The bar under the workspace tabs is where they live ("Add and switch dashboards", issue 32): a `+` after them adds one, and a menu at the far right opens the list they are managed in. **The Inbox is not a Dashboard**; it sits beside them (§5). Every Workspace has at least one, and a Dashboard's name is unique within its Workspace, so two Workspaces may each have a *Research*. (Earlier drafts called this level a *Page*; "dashboard" is what the product is called and what everyone reaches for, so "page" goes back to meaning an ordinary screen.)
Dashboards are renamed and deleted in a list opened from the bar's own menu ("Rename and delete a dashboard from a dashboard settings page", issue 90), so what it acts on is obvious from where it sits. **It opens over the Workspace rather than replacing it**, because renaming a Dashboard is a detour from working on one: the panels, the Inbox and the bar stay behind it, closing puts you back with nothing to reload, and there is no address for it. Adding is not in it — the `+` is a one-gesture thing you do often, and belongs where the new tab will be. The Inbox is not in its list. Renaming obeys the rules adding does, so *Research* may become *RESEARCH* while a name another Dashboard of that Workspace holds is refused with a message saying which. Deleting asks first in the same dialog as everywhere else and says what the Dashboard takes with it: how many Panels go with it, or that there is nothing on it. **A Workspace's last Dashboard cannot be deleted**, the one place the app refuses to delete something: the last Workspace may go because the app can offer to make one, while a Workspace with no Dashboard has no view at all. The entry is in the menu, unavailable, with that sentence on it, rather than offered and then refused. A deleted Dashboard leaves the list and the list stays open, since the row going is the confirmation and a second change should not cost opening it again; deleting the one you were looking at moves the Workspace on behind it, its own address deciding where you land, which you see on closing.

**Panel** — a movable, resizable, titled box on a Dashboard, each a **saved, filtered view of items**, with a user-editable title.

Panels are added, renamed, moved, resized and deleted **on the Dashboard itself** ("Panels on a dashboard, with per-screen-size layouts", issue 33), not on a settings page, because dragging one Panel past another *is* the editing and has to happen where the Panels are drawn. A `+` adds one; each Panel carries a menu opened by the same control as every other menu in the app, offering rename, move and delete. Moving is in both the menu and the pointer — drag the header to reorder — because a drag is unreachable from a keyboard and absent on a touchscreen. Resizing is the corner grip alone: it does in one gesture what step-at-a-time menu entries did clumsily, so a keyboard cannot resize a Panel. A title is required, stored trimmed, one line of at most 60 characters, and unique among a Dashboard's live Panels whatever the capitalization, so two Dashboards of one Workspace may each have a *Reading list*. Deleting asks first, in the same dialog as everywhere else, and says the Panel goes from every Layout of its Dashboard. A Dashboard may have no Panels at all. **A Panel holds the Items filed into it**, in an order you set, and drawing them is all it does: a rule for what *arrives* in one without being filed is configuration it does not have yet ("Panel configuration: connections and free-text description", issue 35).

**Layout** — one arrangement of a Dashboard's Panels, remembering the screen width it was made at, so the same Dashboard reads well on a phone and on a 4K screen. A Dashboard may have several, and which one it is drawn with is decided in "Layouts: one arrangement per screen size" (§6.3).

The full path to any box is `Workspace → Dashboard → Panel`:

```
Workspace: "Work"
├── Dashboard: "Today"       ← landing dashboard
│   ├── Panel: "Focus Today"
│   ├── Panel: "Project Falcon"
│   └── Panel: "People to talk to"
├── Dashboard: "Dormant projects"
│   └── Panel: "On hold"
└── Dashboard: "Research"
    └── Panel: "To read"
```

### 4.2 Item + Association model (resolves "one message in two inboxes")

Everything that flows in — email, Slack message, Notion page, later a calendar event or bookmark — normalizes into a single **Item**, storing: source app (or *internal*), source ID, a deep link back, sender/author, timestamp, its three texts, its **Type**, optional priority, optional due date, and whether it has been finished with. Native notes and to-dos created in the app have no source app and open in the app rather than deep-linking out.

**An Item carries three texts, answering three different questions** ("Edit an item's title and description on a form of its own", issue 159). The **captured message** is what arrived, or what you said: written once when the Item is made and never changed by anything afterwards, because it is the record of what was actually captured. The **title** names the Item and the **description** is what you have to say about it; both are yours to edit and neither is required. The description is plain text today; it gains formatting — bold, italic, links and lists to begin with — kept as Markdown, so it can be worked on as formatted text or as its own source ("Format a description, and edit its source", issue 160).

**A row shows the next action, or the title, or the first 150 characters of the captured message**, and *Untitled* where an Item has none of the three — the best label it has, worked out where the row is drawn. Not stored as a fourth text, which would be a summary free to go stale behind the three it summarises.


Items are **not filed into one folder.** Each carries any number of **Associations**: to one or more **People**, **Projects**, **Topics/Areas** (*Research*, *People to discuss*), a **Workspace** (rarely more than one) and optional **Focus** flags (§7).

Because associations are many-to-many, one message appears in the *Project Falcon* panel **and** the *Anna* panel without being duplicated or moved. A Panel is a query over Items, so the same Item shows up in every Panel whose filter it matches.

**Every Item has a Type** — *Action*, *Thought*, or whatever else you name — which is what kind of thing it is, as against where it stands. The set is open and account-wide, and a Type is made by naming one at capture that does not exist yet ("Capture a thought or an action, and see which it is", issue 155): a type you need once is not worth a trip to a settings page. Capture offers the types you already have, the three used last first, and opens on the one used last.

Types are managed on their own page, a sibling of the workspaces one because they belong to the Account: a row each, renamed and recoloured in the row, deleted through the same dialog as everything else, and put in the order capture offers them in — the Ordering rule, so the grip and the row's own *Move up* and *Move down* are the same move ("Manage the types, and put them in the order you want", issue 156). **There is no way to make one there**, which is the one thing that page does not do: a second place to type a name is a second place for the same word to be spelled differently. **Deleting a Type leaves its Items where they are**, holding everything except the label — the same way deleting a Workspace keeps everything filed against it — and gives the name back.

**An Item is either yours to deal with or finished with**, and nothing in between ("An item is either yours to deal with or finished with", issue 154). Being finished with one is a time, so it says *when*; dismissing one is the tombstone that makes it reversible. The eight-value status this replaced — To Process, Task, Waiting, Snoozed, Delegated, Reference — was never asked for, and six of the eight changed a mark on the row and nothing else. What kind of thing an Item is belongs to its **Type**, and a due date is a field. A Kanban board, a to-do list and the inbox are still all Panels over the same Items.

## 5. The Inbox and the triage flow *(iteration 2)*

*Iteration 1 has no in-app inbox: flagging at the source is the capture mechanism and those items route straight to the panels — the "active capture" case of Model B (§5.1). Iteration 2 adds the Model A triage queue for everything not pre-flagged.*

**The Inbox is every open Item filed on no Panel**, scoped to the current Workspace — not a Panel with rows of its own, but the absence of a filing. That is what makes filing an Item the thing that takes it out of the Inbox, and it is why an Item can be moved back there: moving an Item to the Inbox is taking it off every Panel.

**Where it sits: beside the Dashboards, not among them** ("Show the Inbox beside the dashboards instead of as a tab", issue 117). Everything else flows out of it — it is read while working on a Dashboard and dropped into while looking at something else — so it is not one more view to switch to. Where there is room, it is a column down the left of every screen inside a Workspace, about a fifth of the width with a floor and a ceiling so it stays readable at 1280px and does not swallow a very wide screen; it scrolls on its own and so does the Dashboard beside it. Every screen inside a Workspace has it, including the one the list of Dashboards opens over; the Workspace settings page does not. On a phone, where a fifth of the width is about ninety pixels, the Inbox is a tab pinned at the left of the bar opening a screen of its own — and it keeps that address at every width, so a link made on a phone still works on a desktop. Hiding and hand-resizing it are not part of this yet.

Capture is its first row ("Show one Inbox per workspace, with capture at the top of it", issue 89): writing something down and seeing where it landed are the same place.

Processing an Item means one or more of:

- **Read and respond** — the content is readable in the app, and where the source supports it you can react or reply from here; otherwise the deep link (§6.1) takes you to the source.
- **Flag for follow-up** — it becomes a tracked follow-up on the dashboards, exactly as if flagged at the source.
- **Associate it** — tag it to a Person, Project and/or Topic, which is what puts it in the right panels.
- **Mark it done** — which takes it off every list, saying when.
- **File it on a Panel** — which is what takes it out of the Inbox, and the one thing that does. Every Item's own menu carries **Move to…**, opening a picker of every Panel in the Workspace with the Dashboard you are on first, the three Panels most recently filed into above it, and the Inbox among the targets.
- **Delete/Dismiss** — which is reversible for as long as the bar offering it is on screen ("Undo what just happened", issue 144). A dismissed Item is kept rather than erased, and undismissing it brings it back, so putting it back is the same change made the other way.

Filing it, finishing it or dismissing it takes an Item out of the Inbox; it stays reachable through the Panels holding it, through its associations, and through an optional "All items" view.

**Gestures** ("Swipe an inbox row right to file it, left to dismiss it", issue 145): **swipe left dismisses, swipe right opens the picker** — the same picker **Move to…** opens, so filing is one gesture on a phone and the same question either way. One meaning per direction, in every list rather than only the Inbox: the same swipe cannot mean two things depending on which list it is in, so removing an Item from one Panel stays in the menu. A swipe that stops short puts the row back, and one that is mostly vertical is the list scrolling and does nothing at all. **A swipe is a touch gesture**: on a desktop the same actions are the menu, and a Panel is reached by dragging the row into it.

**Open question:** does "delete" mean delete only here, or also archive/delete in Gmail/Slack? See §12 — the single biggest behavioral decision.

### 5.1 How an Item reaches a box — must it pass through the Inbox first? (undecided)

The reframing that makes this tractable: **"in the Inbox" and "shown in a box" are two independent states, not two ends of one pipeline.** Associations are many-to-many and being finished with an Item is separate (§4.2), so an Item can be in either, both or neither, and "passes through the inbox first" is a per-source default rather than an architecture.

**Model A — Inbox-first (manual triage).** Everything lands in To Process; nothing appears in a box until deliberately filed there. *Pro:* one point of control. *Con:* obvious items still need manual routing.

**Model B — Direct routing by rule.** Rules send certain items straight to a box: "Slack messages in #customer-1 → Customer 1's board", "@mentions on a project → that project's box", "anything I star → its box". *Pro:* far less busywork. *Con:* items appear without a review step, so they need an "unseen" dot or a per-rule "also show in Inbox" toggle.

**Inside Model B, passive vs active capture:** being tagged or @mentioned is *passive* — route it **and** flag as unseen; deliberately saving a message is *active*, a strong intentional signal that should skip the Inbox entirely.

**Recommended lean (a hybrid).** Inbox by default for anything with no matching rule, plus per-source/per-channel routing rules so obvious and actively-saved items land directly in a box, optionally marked "unseen". Decision still open.

### 5.2 Swipe-right — settled

**Swipe-right opens the picker**, the same one **Move to…** opens ("Swipe an inbox row right to file it, left to dismiss it", issue 145). Filing is what an Inbox row most often needs and the picker is where the decision already lives, so a phone gets to it in one gesture rather than three taps.

**One meaning per direction, at one distance.** The other candidates — a quick process sheet, a wake date, done — were going to be told apart by how far the swipe went, and that is what the gesture cannot spare: it is already competing with the list scrolling under the same thumb, so the difference between a short swipe and a long one is not a difference a hand can be relied on to make. They stay in the row's menu, where there is no threshold to miss.

## 6. Dashboards and Panels

**Panels** behave like the tiles on Azumuta's Analytics dashboards: each sits on a grid, **drag to move**, **drag a corner to resize**, an editable **title**, and a **menu of its own** (configure, rename, remove) opened by the same control as every other menu in the app (§11, "One control opens every menu"). A **"+"** adds a Panel. The responsive grid reflows on smaller screens so the same Dashboard works on phone and desktop.

**The grid is always the full width of the screen**, divided into twelve equal columns, and a Panel is a whole number of them, so the Dashboard never scrolls sideways on any device: a Layout made for a 4K screen and opened on a laptop keeps each Panel's *share* of the width and squeezes what that share measures, while the text keeps its normal size. Panels flow left to right and wrap, which is why moving one is a reorder rather than a move to a coordinate — there are no holes to leave behind.

**Panel types for v1:**

- **Project** — all Items associated with a Project, across all sources.
- **Person** — Items and notes tied to a person; doubles as "things to discuss with them".
- **Topic/Area** — a free-form bucket such as *Research*.
- **Focus** — Items flagged Today / This Week / This Month / This Quarter (§7).
- **Highlights / AI summary** — an auto-generated digest (§8).
- **Payments due** *(iteration 2)* — every open Item classified as requiring a payment, across the Workspace's mail accounts, showing extracted amount and due date, using the standard deadline colors (§7.1) and leaving once marked paid. Classification and extraction are AI work on ingest (§8); detecting "paid" is open decision #16. Functionally a specialized live-rule Panel (§6.2), but its rule is an AI classification rather than a source filter.
- **Reading digest** *(iteration 2)* — highlights extracted from technology and research email instead of the emails themselves: the AI detects that a mail is content, splits out its individual stories, matches them against topics of interest, and presents a short "worth reading today" selection linking to the source. This mail never hits To Process and carries no obligation — what is unread ages out rather than accumulating (issue 8, §2). Highlights says what needs follow-up; the Reading digest says what might be worth reading.
- **Kanban** *(candidate for v1 or fast-follow)* — Items as cards in columns you define.
- **Calendar/agenda** *(later)*.

A **Dashboard** is a saved arrangement of Panels; there can be as many per Workspace as you like.

### 6.1 How Items render in a Panel — action cards

Any Panel can present its Items as an action list rather than raw message previews — a **general Panel capability**, not tied to one use case. Each card has:

- A **next-action label** — a short distilled summary of what really needs doing (*"Answer pricing question"*, *"Reply to Tom's question on Part 11 compatibility"*). The required action usually is *not* the last message, so this is genuine LLM work (action extraction, §8), not a copy of the subject line. For internal notes the line is yours, and either way it is **always editable**.
- A **source icon** — mail, Slack, Notion, or an internal-note marker.
- **Deadline color** (§7.1) and a **priority** highlight, independent of any deadline.

Panel-level controls, supported by every Panel: **manual sort** (drag to reorder, remembered); **grouping** by any field (person, project, type, priority); **highlighting** by priority and deadline.

**Where a card links.** An Item from a connected source deep-links into that app at exactly the right place (the Gmail thread, the Slack message, the Notion page), so you act in the real tool rather than a degraded copy. An internal note opens inside this app for viewing and editing.

**The round-trip — updating the card after you replied elsewhere.** The outcome is not always "done": a reply that fully resolves it marks **Done** and the card leaves the Panel; a reply that leaves you awaiting an answer moves the Item to **Waiting / Follow-up**, keeps it in the Panel, and **rewrites its next-action label** — *"Reply to Tom's question on Part 11"* becomes *"Follow up: awaiting Tom's answer on Part 11."* So each Item carries a state-dependent *current next-action*. How the app learns you replied is open decision #10: detect the outbound reply via two-way sync, or prompt on return ("Handled? → Done / Waiting / Still to do"). Recommended: prompt on return in v1.

### 6.2 What a Panel shows — manual promotion + live rules

Two mechanisms combine:

- **Filing.** Any Item can be filed onto a Panel from its own menu, which is what takes it out of the Inbox ("The Inbox and the triage flow"). An Item filed on several Panels appears on all of them: **Add to…** in a row's menu shows it on one more, and **Remove from this panel** stops one Panel showing it while every other carries on — an Item removed from the only Panel holding it is back in the Inbox. Dragging a row from one Panel onto another **asks which was meant**, because both are reasonable and a drag says neither ("Ask whether to move an item to a panel or add it to one", issue 142); a drop from the Inbox asks nothing, there being no answer that leaves it there. On a screen with a pointer it is also **dragged** into the Panel, and dropped between the rows already there: where it is let go is where it lands, and dropping it back into the Panel it is already on reorders that Panel ("Drag an item into a panel, and drop it where you want it", issue 141). A drag is unreachable from a keyboard and absent on a touchscreen, so a row's own menu carries **Move up** and **Move down** — Ordering, the same move made two ways. **A drag near an edge scrolls the page**, so a Panel below the fold can be aimed at — which the browser does by itself and Cockpit does not implement — and **resting one on another Dashboard's name switches to it**, so a Panel that was not on screen when the drag began can be dropped on — and that Dashboard is the one still open afterwards, because it is where you just put something ("Scroll while dragging, and switch dashboards by resting on one", issue 143).
- **Live rules (saved queries).** A Panel can be configured with a rule for what belongs in it ("all messages from the **cust-AtlasCopco** Slack channel", "emails labelled *Pricing*", "Items associated with Project Falcon"). The Panel remembers the rule and any future match **appears automatically**, without touching the Inbox — the panel-level expression of §5.1's direct routing.

**Rules are configured in plain English, not through a wizard.** You describe what the Panel should show in a free-text sentence (*"all emails from customers"*, *"Slack messages where I'm mentioned in the customer channels"*) and the AI translates it into the underlying saved query (§8). The app plays the interpretation back in understandable terms ("this will show: emails, from senders matching your customer list, not yet done") so it can be confirmed or refined by editing the sentence. A multi-step rule wizard is explicitly not wanted; the structured query is the stored, inspectable result of the sentence.

**Attach-and-monitor scope prompt.** Adding a Slack item to a Panel asks *how much* to monitor: **this thread**, **this conversation/DM**, or **this channel** (the live-rule case). The same generalizes to other sources — one email thread versus a whole label, one Notion page versus a database. The scope picked becomes the Panel's live rule.

### 6.3 Layouts: one arrangement per screen size

A 4K screen fits more Panels side by side than a laptop, which fits more than a phone, so a Dashboard can hold **several Layouts** and each one **records the screen width it was made at** ("Panels on a dashboard, with per-screen-size layouts", issue 33). That width is whatever the screen happened to be, not one of a fixed set of breakpoints, so there is nothing to belong to and nothing to configure.

**Which Layout a Dashboard is drawn with.** By default the one whose recorded width is closest to the screen in front of you; a tie goes to the narrower, so two devices of the same size agree. You can also pick one by hand, from the Dashboard's own Layouts menu, and that choice is remembered in the browser rather than stored — the whole point of Layouts is that the phone and the desktop want different ones. A Layout that is deleted, or a hand-picked one that another device deletes, simply falls back to the closest remaining. A Dashboard with no Layout at all is drawn arranged for the screen it is on.

**Changing a Layout on a screen it was not made for asks which one you mean.** Dragging, resizing and the **"Fit to this screen"** button all end in the same question when the Layout being drawn was made for a different width: *change this Layout*, or *make a Layout for this screen*. Either answer is reasonable — a Panel widened on a laptop while the 4K Layout is on screen might mean either — and guessing would silently rewrite an arrangement made somewhere else. The change is already on screen behind the question, because what is being asked is where to keep it, not whether it happened; cancelling puts it back. On the screen a Layout *was* made for, and on a Dashboard that has no Layout, one of the two answers is not an answer, so the change is simply kept.

**"Fit to this screen"** rearranges the Panels for the screen you are on: it keeps their order and fills the rows left to right, giving each an equal share of the width, at a count that keeps a Panel worth reading — one across on a phone, three on a laptop, four on anything wider. Heights are left alone, because a Panel somebody made tall was made tall on purpose. On a Dashboard that has never been arranged the Panels do not move, since that is already how they are drawn; what the press records is the Layout, which was not there before.

## 7. Focus and Goals (time-horizon priorities)

Any Item can be flagged with a **Focus horizon**: **Today, This Week, This Month, This Quarter**. These are date-anchored, not merely colored, which is the key requirement.

- An Item flagged **Today** is anchored to today's date and renders as **Overdue** the next day if not completed. The same escalation applies to Week/Month/Quarter as each period ends.
- **End-of-period review.** As a month or quarter closes, the app surfaces a roll-up if too many Focus items are still open ("You have 6 open items in this quarter's focus with 3 days left").
- **How you set it.** Select Items in any Panel and choose *"Add to This Week's Focus"*, or set it from the Item's detail view. A **Focus Panel** shows what is committed to per horizon.

### 7.1 Deadline color states

Independently of Focus horizons, an Item can carry a hard **due date**, and cards are color-coded by proximity: neutral while there is time, **orange** once the deadline is reached (due today, or within a set threshold), **red** once passed, in every Panel the item appears in. A "This Week" focus flag anchors to end-of-week while a due date is a specific date, but both feed the same treatment.

## 8. AI layer: executive summaries and highlights

- **Per-item / per-thread summary** so long or technical messages can be triaged without reading the whole thread.
- **Action extraction (the next-action label).** Read the full thread, not the last message, and distil the concrete thing to do into one line (§6.1). Always editable.
- **Suggested associations.** On arrival, propose the likely Project/Person/Topic tags to confirm or override. This is where most of the day-to-day value is.
- **Dashboard highlights digest** — "here is what needs follow-up today" across all sources, optionally as a daily push.
- **Plain-English panel rules** — turn a free-text description into the structured saved query behind a Panel and render the interpretation back for confirmation (§6.2).
- **Reading-digest topic extraction** *(iteration 2)* — detect that an email is content rather than correspondence, split it into its individual stories, and rank those against topics of interest. Finer-grained than a per-item summary, since one newsletter can hold ten unrelated stories of which one matters.

Where the AI runs (cloud versus on-device) interacts with the offline requirement — open decision #6.

## 9. Integrations and connections

**Connections are configured per Workspace.** Each Workspace declares which accounts it pulls from (*Work* uses work Gmail + company Slack + work Notion; *Personal* uses personal Gmail). This is both the privacy boundary and the source filter.

- **v1:** Gmail, Slack, Notion. In **iteration 1** these pull only explicitly marked items; in **iteration 2** they widen to the full stream.
- **Phase 2:** Linear, Google Calendar. **Phase 3:** Chrome bookmarks and downloads, YouTube saved videos.

**Feasibility reference.** [integration-options.html](integration-options.html) (as of Aug 2026) rates 15 candidate sources: nine integrate cleanly through official APIs or open protocols (Gmail, Telenet IMAP, the three Slack flavors, Microsoft Teams, Google Tasks, Google Calendar, Billit), three are partial (Signal via signal-cli, Notion mentions via polling, with Notion action items the clean exception), and three have no official read path (personal WhatsApp, LinkedIn InMail and connection requests, where the only workarounds violate the platforms' terms). Reverify the restricted platforms before committing to a build.

Each connector authenticates (OAuth), pulls new items on a schedule or push, normalizes them into the Item model, and — where two-way sync is enabled — pushes status changes back.

## 10. Offline / local-first behavior

The local copy serves **instant rendering** first and **offline availability** second (issue 9, §2). Because offline is the rare case it gets the simple version of everything: a cache plus a queue, no peer-to-peer sync, no elaborate conflict resolution.

- A local copy of synced Items, associations, panels, dashboards and workspaces makes the app **viewable and triageable offline**.
- **Reads offline:** current status, already-synced items, dashboards.
- **Writes offline:** triage actions are captured locally and **queued**.
- **On reconnect:** queued changes sync to the backend and to source apps where two-way sync applies, and new items pull down. Recommended conflict rule: last-write-wins per field, with source apps read-only unless two-way sync is explicitly enabled.
- New incoming messages only arrive when online; offline means the app still works with what it already has.

### 10.1 Staleness and reconciliation (keeping the copy honest)

The source apps remain the source of truth for everything they own. The rule that keeps this tractable is a strict split of every Item's fields:

- **Source-owned facts** — whether the underlying object still exists, its content, its state at the source. Every re-sync overwrites the cache unconditionally; the app never argues with the source about the source's own data.
- **App-owned facts** — associations, focus flags, whether it has been finished with, edited next-action labels, panel placement, manual sort order. Reconciliation never touches these.

Convergence is layered, cheapest first, and a source change should have the same effect as processing the item here (so completing something in Notion counts as done, per issue 1):

- **Push where the source offers it** — Slack events and Gmail push notifications, near-real time at almost no cost.
- **Periodic delta re-sync** for sources without reliable push (Notion is polling-based), on a modest interval while the app is open and on focus or launch.
- **Opportunistic re-verification** — on returning from a click-through (a moment the app already watches for the round-trip prompt, §6.1), re-fetch that item.
- **Tombstones instead of silent deletes** — an object that disappears or completes at the source marks the Item *resolved at source* rather than vanishing. Whether that surfaces for confirmation is open decision #18.

Each Item carries a *last-verified* timestamp, and a Panel can show how fresh its data is ("synced 2 min ago") so a stale view is at least an honest one.

## 11. Non-functional requirements

- **One control opens every menu.** Wherever something has a menu — the header, an Inbox row, the dashboard bar, every Panel — it is opened by the same control: a vertical triplet of dots, one size, one hover and focus treatment, carrying its own name for whoever is not looking at it ("Open every menu from the same control", issue 115). Three dots therefore always mean a menu, never a link that navigates. It is drawn rather than typed, because `···` is punctuation whose size and baseline belong to the font.
- **Responsive UI** — desktop layouts use the full screen (dense, multi-column panel grids, not a narrow centered column); mobile reflows to a single-column, touch-and-swipe layout. The panel grid adapts per breakpoint.
- **Installable PWA** (or native shell) for offline use and mobile gestures.
- **SaaS-ready architecture** — every row scoped to an account, now actually exercised by more than one; OAuth-based auth; per-user encrypted storage of source tokens. OAuth is still outstanding: today a User signs in by choosing a name.
- **Security & privacy** — source credentials encrypted; workspace scoping enforced server-side, not just in the UI; clear handling of message content sent to any AI service.
- **Performance** — dashboards render from the local cache instantly; syncing happens in the background.

## 12. Open decisions (need your call — recommendations included)

*Notification-class email, how "paid" is detected and the Reading digest's topics concern the iteration 2 inbox and its panels and can stay open until that phase. The rest touch the shared model and are best decided before or during iteration 1.*

1. **One-way vs two-way sync.** Should archiving or marking done here change the source? *Recommendation: read-only in v1, two-way sync opt-in per connector later.* Highest-impact decision.
2. **Inbox-first vs direct routing (§5.1).** *Recommendation: hybrid — inbox by default, per-source rules for the obvious cases, with an "unseen" marker on auto-routed cards.*
3. ~~**Swipe-right meaning.**~~ *Settled: it opens the picker, and there is no short-versus-long split — see "Swipe-right — settled".*
4. ~~**Tasks — separate object or Item status?**~~ *Answered: neither. An Item has a **Type**, and a due date is a field — see "An item is either yours to deal with or finished with" (issue 154) and "Capture a thought or an action, and see which it is" (issue 155). All panels still share one model.*
5. **Auto-tagging trust level.** Applied automatically with undo, or suggested for confirmation? *Recommendation: suggest-and-confirm in v1; auto-apply once trusted.*
6. **AI location vs offline.** *Recommendation: generate on sync in the cloud, cache the result so it reads offline.*
7. **Multi-workspace items.** *Recommendation: one primary Workspace per item to keep the privacy boundary clean; use Topics/Projects for cross-cutting.*
8. **Kanban in v1 or fast-follow?**
9. **Reminders/notifications channel.** Push (PWA), email, both? Needed for the §7 reminders.
10. **Reply detection / round-trip (§6.1).** *Recommendation: prompt on return in v1, sync-detection later. Depends on decision #1.*
11. **Action-label generation (§6.1).** *Recommendation: AI drafts, you edit; store both the original subject and your label so nothing is lost.*
12. **Live panels — de-dup and inbox interaction (§6.2).** Do matching items also hit the Inbox, and how is panel clutter avoided? *Recommendation: reuse the §5.1 "inbox yes/no per rule" flag; an item can appear in several panels but stays a single object, so acting on it once updates it everywhere.*
13. **Workspace colors.** **Answered: auto then user-picked.** A new Workspace gets the first color no other Workspace is using, so it never exists without an identity and nobody is asked for one to create it; the workspace settings page then offers swatches to change it. What is picked is a **theme of four colors** (§4.1), all four stored on the Workspace, so a free color wheel later is a second writer of the same fields rather than a migration — and the fourth is stored rather than mixed from the two it sits between, so an entry stays tunable by hand. Legibility comes from the palette being fixed sets designed together and from nothing else recoloring. Dark mode is not decided here; when it lands, each theme gains its dark set beside its light one.
14. **Grouped vs individual actions (issue 5, §2).** What drives grouping — the source container, a shared project association, an AI suggestion, or a manual merge? *Recommendation: default to individual Items; let AI suggest a group when several open items share both their source container and their project association, with manual group/ungroup as the override. A group renders as one card with a count and expands in place.*
15. **Notification-class email (issue 6, §2).** *Recommendation: classify on ingest (sender and header heuristics plus AI); keep notification-class items out of the Inbox in a collapsible Notifications feed; where a notification maps onto an existing Item or a Panel's live rule, apply it as a state-change signal instead of a new item. Escalate into the Inbox only when personally directed and actionable — an assignment, a mention, an invite needing a response.*
16. **Payments — how is "paid" detected (issue 7, §2)?** *Recommendation: manual mark-as-paid in v1, with AI-detected confirmation emails as a suggested (not automatic) match; bank or accounting reconciliation (e.g. Billit) as a later connector.*
17. **Reading digest — topics of interest and leftovers (issue 8, §2).** How are topics defined, what happens to unread highlights, and is the panel continuous or daily? *Recommendation: a short manual topic list per Workspace refined by click-through behavior later; age highlights out of the panel after a few days but keep the emails searchable; compose the selection once per day so it reads as "today's picks" rather than another growing feed.*
18. **Reconciliation cadence and disappeared-item behavior (issue 9, §2, and §10.1).** *Recommendation: push where available plus polling on app focus and every few minutes while open; completed-at-source auto-completes with an undo trail; deleted-at-source removes it from panels but keeps it findable with a "removed at source" marker. Add confirmation prompts only if silent resolution bites.*

## 13. Scope per iteration (proposed)

**Iteration 1 — follow-up tracking:** Workspaces, Dashboards and Panels (move/resize/title) with plain-English rule configuration (§6.2); the Item model with associations; read-only Gmail/Slack/Notion connectors limited to flagged and assigned items; fast capture of internal notes (issue 2, §2); Project, Person, Topic, Focus and Highlights panels; the four Focus horizons with overdue escalation; per-item AI summaries, next-action labels and suggested tags; local-first offline viewing with queued actions; source reconciliation (§10.1).

**Iteration 2 — unified inbox:** the same connectors widened to the full stream; the triage inbox with its swipes and filing (§5); reading and replying in the app; flag-for-follow-up feeding the iteration 1 dashboards; notification-class email routing (#15); Payments due and Reading digest panels.

**Later:** two-way sync beyond replies; Linear and Calendar; Chrome and YouTube; Kanban and calendar panels; end-of-period roll-up reminders; multi-user billing and onboarding.

## 14. Glossary

- **Account** — the person or organization Cockpit holds work for, and the outermost boundary: everything belongs to exactly one, and nothing is shared between two. Each User has one. Not the *source accounts* (a Gmail login, a Slack workspace) a Workspace connects to. The **register** is the list of which Accounts exist, who the Users are and who is signed in; it is what says an Account is real before any of its data is opened.
- **Workspace** — top-level context inside an Account and the privacy boundary (Work, Personal, Customer 1…); defines which sources are connected.
- **Dashboard** — a switchable named view inside a Workspace, holding a layout of Panels.
- **Panel** — a movable, resizable, titled box on a Dashboard displaying a filtered set of Items. Its title is unique within its Dashboard.
- **Layout** — one arrangement of a Dashboard's Panels — their order and each one's size — together with the screen width it was made at. A Dashboard can have several, so it reads well on a phone and on a 4K screen; the app draws it with the one closest to the screen in front of you unless you pick another.
- **Inbox** — the one place in a Workspace holding what has arrived and not been dealt with: every open Item filed on no Panel. Beside the Dashboards rather than one of them, and never renamed or deleted, because it is not a Panel — it is what is left when nothing holds an Item.
- **Item** — the single object everything is stored as, whether it arrived from a source or was created in the app. **Action** and **Thought** are *types* of Item, not separate objects.
- **Type** — what kind of thing an Item is: *Action*, *Thought*, and whatever else you name. The set is open and account-wide, and a Type comes into existence by being used — naming one at capture that is not there yet makes it ("Capture a thought or an action, and see which it is", issue 155). Each wears a colour from the palette, which is the dot at the head of a row; the name beside it is what carries the meaning. A Type says what an Item *is*, where **Done** says where it stands. Types are renamed, recoloured, ordered and deleted on a page of their own, and an Item whose Type is deleted keeps everything but the label ("Manage the types, and put them in the order you want", issue 156).
- **Action** — an Item representing something to do. One source Item can produce several.
- **Thought** — an Item created in the app as a note or idea, with no source behind it.
- **Captured message** — what arrived, or what you said, as it stood when the Item was made. Never edited afterwards, and shown only when you ask to see it, so there is always a way back to what was originally captured.
- **Title** — the short name an Item goes by. Yours to edit, not required, and what a row shows when there is no next action.
- **Description** — what you have to say about an Item: as long as it needs to be, edited on the Item's form. Plain text until it gains formatting ("Format a description, and edit its source", issue 160).
- **Association** — a link from an Item to a Person, Project, Topic or Focus flag; many-to-many, which is why an Item can appear in several Panels.
- **Capture** — creating an Item directly in the app instead of receiving it from a source.
- **Done** — finished with, recorded as the time it happened. An Item is either yours to deal with or done; there is nothing in between, and a Type says what kind of thing it is rather than where it stands.
- **Priority** — low / normal / high importance, independent of the Focus horizon.
- **Next action** — the short, always-editable label describing what to actually do about an Item.
- **Focus horizon** — Today / This Week / This Month / This Quarter, date-anchored so it escalates to overdue.
- **Triage / process** — dealing with what arrived: associating an Item, filing it where it belongs, and finishing with it or dismissing it.
- **Undo** — putting back what the last change took away, offered briefly after it and never afterwards. One step, not a stack: what an accident needs is a way back, offered where you are looking.
- **Form** — where more than one field is edited at once: a modal with a route of its own, so the back button closes it and a link opens it. **Save** writes; Cancel, Escape and pressing outside discard without asking.
- **Filing** — putting an Item on a Panel. An Item can be filed on several Panels at once, which is why one thing to do can appear on *Project Falcon* and on *Anna*; one filed nowhere is in the Inbox. Each filing carries its own place in that Panel's order, so an Item can be first on one Panel and fifth on another.
- **Offline** — working from the local copy when the connection is not there. Cockpit opens, shows what it already holds, and takes what you capture and triage; those changes queue and go up on reconnect. Nothing new arrives from a source until the connection is back, and what the copy shows is said to be as old as it is rather than presented as current ("Offline / local-first behavior", §10).
- **User** — a person who uses this Cockpit. Each User owns one Account, which is what makes two Users' work separate. A User has a **Role**.
- **Role** — *user* or *admin*. Carried today and enforced nowhere; the first admin-only part of the app brings the check with it.
- **Sign in** — saying which User you are. Today by choosing a name on the **logon page**, which proves nothing and is meant not to; passwords and Google sign-in replace that step later. A sign-in lasts a set time, renews while used, and expires on its own, and Cockpit says so rather than failing at you.
- **Sign out** — ending a sign-in deliberately. Cockpit forgets it and the browser is left holding nothing of what you were looking at.

Five things the app does in the same way wherever it does them, named here because a shared behaviour with no word is one nobody can say is tested (`tools/test-explorer/concepts.json`):

- **Menu** — the control a row's actions open from, three dots wherever it appears. An action that cannot be taken stays in the menu, unavailable, saying why, rather than disappearing.
- **Deleting** — asking before anything goes, in a dialog naming what is going and what goes with it, offering Cancel and Delete in that fixed order. Escape and Cancel are the two ways to say no.
- **Ordering** — putting rows in the order you choose, by dragging one or by moving it a step at a time from its own menu; the two are the same move.
- **Live updates** — a change made in one place reaching everywhere else it is shown, without a reload.
- **Updating** — picking up a new version of Cockpit. A tab running one older than the server can read nothing it is told, so it stops, fetches the newer one and comes back where you were, rather than asking. Your sign-in and your work are untouched; the version is the only thing that was wrong. Where there is no newer one to fetch, it says so instead of trying again.

This glossary is binding on anything written to be read as a description of the product, test names included (see `docs/testing-strategy.md`, "Tests are named in the product's language"). Words that live only in `docs/architecture.md` — command, envelope, tombstone, idempotency, last-write-wins — are implementation and stay there.
