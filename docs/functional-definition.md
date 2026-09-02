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
- **Audience — personal-first, SaaS-ready.** Built for one person first, with a data model, tenancy and auth that could become a multi-tenant product without a rewrite. **There is now more than one User**, each in an Account of their own ("Sign in by picking a name, each user in their own account", issue 86). A passwordless list of names is an identity selector, not an authentication control, which is why Cloudflare Access still fronts every deployed environment; what it does mean is that the tenancy the schema always carried is exercised rather than assumed. Never hard-code how many Accounts exist into the schema.
- **Offline — local-first.** Syncing happens online, but the app must open, show current status, read synced items and triage them without a connection; offline changes queue and reconcile on reconnect. Per issue 9 (§2), instant rendering is the primary purpose and offline use should fall out of the cache design rather than drive machinery of its own.
- **Inbox — triage queue.** The Inbox lists *items still to process*, not a permanent mirror of every message. A processed item leaves it but stays visible in whatever panels its associations feed. (Iteration 2; see the interim note in §5.)
- **v1 sources — Gmail, Slack, Notion.** Linear, Google Calendar, Chrome (bookmarks/downloads) and YouTube (saved videos) are later phases.

## 4. Core concepts and terminology

Everything is built from a **container hierarchy** and an **item model**.

### 4.1 Container hierarchy (resolves "dashboard vs workspace")

**Workspace** — the top-level context and the privacy boundary (*Work*, *Personal*, *Home*, *Customer 1*). It controls **which source accounts are connected and visible**, so private email is invisible while in *Work*: scoping rather than filtering after the fact.

Each Workspace has a **color identity of three colors**: a saturated tint on the tab dot and header stripe, the page ground behind the panels, and the header bar one step deeper in the same hue. Switching Workspace repaints all three, so which one you are in is always obvious. Nothing else moves — cards, rows, controls and text keep the fixed neutral and accent palette — which is what lets the colors be chosen freely. They are picked as a set from a fixed palette on the workspace settings page (open decision #13).

Workspaces are made, renamed, ordered and deleted from the workspace settings page, where each is a row with its own menu. A name is required, stored trimmed, one line of at most 60 characters, and unique among live Workspaces whatever the capitalization. **Deleting a Workspace keeps everything that was in it**: its Items stay filed against it, because the router learns from the whole history of where things were filed (routing that learns from past decisions, "What the model reads: the whole history, no retrieval"). The name becomes available again. The last Workspace can be deleted, and the app then opens on the page that makes one.

**The order of the rows on that page is the order of the tabs across the top, left to right** ("Reorder workspaces", issue 31). A new Workspace goes last, after every Workspace the account has ever had; deleting one closes the gap. Two ways to move one, neither the lesser: the grip at the left of a row drags it, and **Move up** / **Move down** in the row's menu take it one step. The menu is the only way a keyboard has and the comfortable way on a phone, so on the first row **Move up** stays in the menu, unavailable, saying *It is already the first*, rather than disappearing. A move shows itself before the server agrees — the one change on that page that does not wait, so a second move can follow a first and a dropped row does not snap back for a round trip. If it is refused, because a Workspace was made or deleted in another tab, the row goes back and says so.

**Deleting anything asks first, in a dialog, and the row it was asked from does not change** ("Ask before deleting in a dialog, from the row's own menu", issue 116). The question names what is going and what goes with it — for a Workspace, how many Items stop being visible — and offers Cancel and Delete in one fixed order everywhere, so the control under the pointer never changes meaning between the press that asks and the press that answers. Escape and Cancel are the two ways to say no; pressing outside is deliberately not one. Focus returns to the row it was asked from. Nothing is sent until Delete is pressed, and a Workspace's Delete waits for the count it is asking about, though a count that could not be read at all lets it through rather than trapping you. A refusal keeps the dialog open and says why. Renaming is not destructive and stays in the row.

**Dashboard** — a named view *inside* a Workspace, switched between like tabs. The bar under the workspace tabs is where they live ("Add and switch dashboards", issue 32): a `+` after them adds one, and a menu at the far right leads to the dashboard settings page. **The Inbox is not a Dashboard**; it sits beside them (§5). Every Workspace has at least one, and a Dashboard's name is unique within its Workspace, so two Workspaces may each have a *Research*. (Earlier drafts called this level a *Page*; "dashboard" is what the product is called and what everyone reaches for, so "page" goes back to meaning an ordinary screen.)

Dashboards are renamed and deleted from the dashboard settings page ("Rename and delete a dashboard from a dashboard settings page", issue 90), reached from the bar it governs, so what it acts on is obvious from where it sits. The Inbox is not in its list. Renaming obeys the rules adding does, so *Research* may become *RESEARCH* while a name another Dashboard of that Workspace holds is refused with a message saying which. Deleting asks first in the same dialog as everywhere else and says what the Dashboard takes with it: how many Panels go with it, or that there is nothing on it. **A Workspace's last Dashboard cannot be deleted**, the one place the app refuses to delete something: the last Workspace may go because the app can offer to make one, while a Workspace with no Dashboard has no view at all. The entry is in the menu, unavailable, with that sentence on it, rather than offered and then refused. Deleting the one you are looking at returns you to the Workspace, whose address decides where you land.

**Panel** — a movable, resizable, titled box on a Dashboard, each a **saved, filtered view of items**, with a user-editable title.

Panels are added, renamed, moved, resized and deleted **on the Dashboard itself** ("Panels on a dashboard, with per-screen-size layouts", issue 33), not on a settings page, because dragging one Panel past another *is* the editing and has to happen where the Panels are drawn. A `+` adds one; each Panel carries a menu opened by the same control as every other menu in the app, and everything it offers — rename, move, resize, delete — is also a pointer gesture: drag the header to reorder, drag the corner to resize. Both directions exist because neither suffices alone — a drag is unreachable from a keyboard and absent on a touchscreen, and a corner grip is a target no thumb wants. A title is required, stored trimmed, one line of at most 60 characters, and unique among a Dashboard's live Panels whatever the capitalization, so two Dashboards of one Workspace may each have a *Reading list*. Deleting asks first, in the same dialog as everywhere else, and says the Panel goes from every Layout of its Dashboard. A Dashboard may have no Panels at all. What a Panel *shows* is configuration it does not have yet — today it is a box with a title and a place — and arrives with "Render actions in panels, backed by one shared action list" (issue 36).

**Layout** — one arrangement of a Dashboard's Panels, remembering the screen width it was made at, so the same Dashboard reads well on a phone and on a 4K screen. A Dashboard may have several, and which one it is drawn with is decided in "Layouts: one arrangement per screen size" (§6.3).

The full path to any box is `Workspace → Dashboard → Panel`:

```
Workspace: "Work"
├── Dashboard: "Today"       ← landing dashboard
│   ├── Panel: "To Process"  (the inbox view, scoped to Work)
│   ├── Panel: "Focus Today"
│   ├── Panel: "Project Falcon"
│   └── Panel: "People to talk to"
├── Dashboard: "Dormant projects"
│   └── Panel: "On hold"
└── Dashboard: "Research"
    └── Panel: "To read"
```

### 4.2 Item + Association model (resolves "one message in two inboxes")

Everything that flows in — email, Slack message, Notion page, later a calendar event or bookmark — normalizes into a single **Item**, storing: source app (or *internal*), source ID, a deep link back, sender/author, timestamp, title, a text preview or body, optional priority, optional due date, and its status. Native notes and to-dos created in the app have no source app and open in the app rather than deep-linking out.

Items are **not filed into one folder.** Each carries any number of **Associations**: to one or more **People**, **Projects**, **Topics/Areas** (*Research*, *People to discuss*), a **Workspace** (rarely more than one), optional **Focus** flags (§7), and a **processing status** (§5).

Because associations are many-to-many, one message appears in the *Project Falcon* panel **and** the *Anna* panel without being duplicated or moved. A Panel is a query over Items, so the same Item shows up in every Panel whose filter it matches.

**Tasks vs Items (recommendation):** treat a to-do as an Item given a *status of "task"* plus optional due date, not a separate silo. A Kanban board, a to-do list and the inbox are then all Panels over the same Items.

## 5. The Inbox and the triage flow *(iteration 2)*

*Iteration 1 has no in-app inbox: flagging at the source is the capture mechanism and those items route straight to the panels — the "active capture" case of Model B (§5.1). Iteration 2 adds the Model A triage queue for everything not pre-flagged.*

The Inbox is a Panel type showing every Item with status **To Process**, scoped to the current Workspace.

**Where it sits: beside the Dashboards, not among them** ("Show the Inbox beside the dashboards instead of as a tab", issue 117). Everything else flows out of it — it is read while working on a Dashboard and dropped into while looking at something else — so it is not one more view to switch to. Where there is room, it is a column down the left of every screen inside a Workspace, about a fifth of the width with a floor and a ceiling so it stays readable at 1280px and does not swallow a very wide screen; it scrolls on its own and so does the Dashboard beside it. The Dashboard settings page has it, being inside a Workspace; the Workspace settings page does not. On a phone, where a fifth of the width is about ninety pixels, the Inbox is a tab pinned at the left of the bar opening a screen of its own — and it keeps that address at every width, so a link made on a phone still works on a desktop. Hiding and hand-resizing it are not part of this yet.

> **Interim, since "Show one Inbox per workspace, with capture at the top of it" (issue 89):** the Inbox currently shows every *open* Item — everything except Done and dismissed — not only the unprocessed ones, and Capture is its first row. Giving a Task, Waiting or Snoozed Item a status of its own would otherwise make it vanish from the only list there is. Panels are what give them homes, and a Panel is a box with a title until it is given something to show: the Inbox narrows back to the sentence above when "Render actions in panels, backed by one shared action list" (issue 36) lands.

Processing an Item means one or more of:

- **Read and respond** — the content is readable in the app, and where the source supports it you can react or reply from here; otherwise the deep link (§6.1) takes you to the source.
- **Flag for follow-up** — it becomes a tracked follow-up on the dashboards, exactly as if flagged at the source.
- **Associate it** — tag it to a Person, Project and/or Topic, which is what puts it in the right panels.
- **Set a status** — *Done*, *Waiting on someone*, *Scheduled/Snoozed until a date*, *Delegated*, *Reference/Archive*, or *Convert to Task* with a due date.
- **Delete/Dismiss.**

Once its status is not *To Process* it leaves the Inbox but stays reachable through its associations and an optional "All items" view. (Today only *Done* and *Dismissed* take an Item out — see the interim note.)

**Gestures:** swipe left = delete/dismiss; swipe right = file into a box (candidate meaning, §5.2). On desktop the same actions are buttons, keyboard shortcuts and drag-into-panel.

**Open question:** does "delete" mean delete only here, or also archive/delete in Gmail/Slack? See §12 — the single biggest behavioral decision.

### 5.1 How an Item reaches a box — must it pass through the Inbox first? (undecided)

The reframing that makes this tractable: **"in the Inbox" and "shown in a box" are two independent states, not two ends of one pipeline.** Associations are many-to-many and status is separate (§4.2), so an Item can be in either, both or neither, and "passes through the inbox first" is a per-source default rather than an architecture.

**Model A — Inbox-first (manual triage).** Everything lands in To Process; nothing appears in a box until deliberately filed there. *Pro:* one point of control. *Con:* obvious items still need manual routing.

**Model B — Direct routing by rule.** Rules send certain items straight to a box: "Slack messages in #customer-1 → Customer 1's board", "@mentions on a project → that project's box", "anything I star → its box". *Pro:* far less busywork. *Con:* items appear without a review step, so they need an "unseen" dot or a per-rule "also show in Inbox" toggle.

**Inside Model B, passive vs active capture:** being tagged or @mentioned is *passive* — route it **and** flag as unseen; deliberately saving a message is *active*, a strong intentional signal that should skip the Inbox entirely.

**Recommended lean (a hybrid).** Inbox by default for anything with no matching rule, plus per-source/per-channel routing rules so obvious and actively-saved items land directly in a box, optionally marked "unseen". Decision still open.

### 5.2 Swipe-right — options to keep in mind (undecided)

Swipe-left = delete. Candidates for swipe-right, to be tested rather than decided now: **file into a box** (a picker, or repeat the last-used box — best if Model A dominates); **quick process sheet** (associations and status in one gesture); **snooze / defer**; **mark done**. They are not exclusive: a short swipe could file while a long swipe handles snooze or done. Prototype on the phone before locking in.

## 6. Dashboards and Panels

**Panels** behave like the tiles on Azumuta's Analytics dashboards: each sits on a grid, **drag to move**, **drag a corner to resize**, an editable **title**, and a **menu of its own** (configure, rename, remove) opened by the same control as every other menu in the app (§11, "One control opens every menu"). A **"+"** adds a Panel. The responsive grid reflows on smaller screens so the same Dashboard works on phone and desktop.

**The grid is always the full width of the screen**, divided into twelve equal columns, and a Panel is a whole number of them, so the Dashboard never scrolls sideways on any device: a Layout made for a 4K screen and opened on a laptop keeps each Panel's *share* of the width and squeezes what that share measures, while the text keeps its normal size. Panels flow left to right and wrap, which is why moving one is a reorder rather than a move to a coordinate — there are no holes to leave behind.

**Panel types for v1:**

- **To Process** — the triage queue (§5). *(Iteration 2.)*
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

Panel-level controls, supported by every Panel: **manual sort** (drag to reorder, remembered); **grouping** by any field (person, project, status, priority); **highlighting** by priority and deadline.

**Where a card links.** An Item from a connected source deep-links into that app at exactly the right place (the Gmail thread, the Slack message, the Notion page), so you act in the real tool rather than a degraded copy. An internal note opens inside this app for viewing and editing.

**The round-trip — updating the card after you replied elsewhere.** The outcome is not always "done": a reply that fully resolves it marks **Done** and the card leaves the Panel; a reply that leaves you awaiting an answer moves the Item to **Waiting / Follow-up**, keeps it in the Panel, and **rewrites its next-action label** — *"Reply to Tom's question on Part 11"* becomes *"Follow up: awaiting Tom's answer on Part 11."* So each Item carries a state-dependent *current next-action*. How the app learns you replied is open decision #10: detect the outbound reply via two-way sync, or prompt on return ("Handled? → Done / Waiting / Still to do"). Recommended: prompt on return in v1.

### 6.2 What a Panel shows — manual promotion + live rules

Two mechanisms combine:

- **Manual promotion.** Any Item can be promoted from the Inbox into a specific Panel — the explicit "file into a box" action (§5.2).
- **Live rules (saved queries).** A Panel can be configured with a rule for what belongs in it ("all messages from the **cust-AtlasCopco** Slack channel", "emails labelled *Pricing*", "Items associated with Project Falcon"). The Panel remembers the rule and any future match **appears automatically**, without touching the Inbox — the panel-level expression of §5.1's direct routing.

**Rules are configured in plain English, not through a wizard.** You describe what the Panel should show in a free-text sentence (*"all emails from customers"*, *"Slack messages where I'm mentioned in the customer channels"*) and the AI translates it into the underlying saved query (§8). The app plays the interpretation back in understandable terms ("this will show: emails, from senders matching your customer list, status not done") so it can be confirmed or refined by editing the sentence. A multi-step rule wizard is explicitly not wanted; the structured query is the stored, inspectable result of the sentence.

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
- **Suggested associations.** On arrival, propose the likely Project/Person/Topic tags and a status to confirm or override. This is where most of the day-to-day value is.
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
- **App-owned facts** — associations, focus flags, processing status, edited next-action labels, panel placement, manual sort order. Reconciliation never touches these.

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

*Decisions #3, #15, #16 and #17 concern the iteration 2 inbox and its panels and can stay open until that phase. The rest touch the shared model and are best decided before or during iteration 1.*

1. **One-way vs two-way sync.** Should archiving or marking done here change the source? *Recommendation: read-only in v1, two-way sync opt-in per connector later.* Highest-impact decision.
2. **Inbox-first vs direct routing (§5.1).** *Recommendation: hybrid — inbox by default, per-source rules for the obvious cases, with an "unseen" marker on auto-routed cards.*
3. **Swipe-right meaning (§5.2).** *Recommendation: short swipe-right files into a box; long swipe or button for snooze/done. Prototype on phone first.*
4. **Tasks — separate object or Item status?** *Recommendation: Item with a "task" status plus due date, so all panels share one model.*
5. **Auto-tagging trust level.** Applied automatically with undo, or suggested for confirmation? *Recommendation: suggest-and-confirm in v1; auto-apply once trusted.*
6. **AI location vs offline.** *Recommendation: generate on sync in the cloud, cache the result so it reads offline.*
7. **Multi-workspace items.** *Recommendation: one primary Workspace per item to keep the privacy boundary clean; use Topics/Projects for cross-cutting.*
8. **Kanban in v1 or fast-follow?**
9. **Reminders/notifications channel.** Push (PWA), email, both? Needed for the §7 reminders.
10. **Reply detection / round-trip (§6.1).** *Recommendation: prompt on return in v1, sync-detection later. Depends on decision #1.*
11. **Action-label generation (§6.1).** *Recommendation: AI drafts, you edit; store both the original subject and your label so nothing is lost.*
12. **Live panels — de-dup and inbox interaction (§6.2).** Do matching items also hit the Inbox, and how is panel clutter avoided? *Recommendation: reuse the §5.1 "inbox yes/no per rule" flag; an item can appear in several panels but stays a single object, so acting on it once updates it everywhere.*
13. **Workspace colors.** **Answered: auto then user-picked.** A new Workspace gets the first color no other Workspace is using, so it never exists without an identity and nobody is asked for one to create it; the workspace settings page then offers swatches to change it. What is picked is a **theme of three colors** (§4.1), all three stored on the Workspace, so a free color wheel later is a second writer of the same fields rather than a migration. Legibility comes from the palette being fixed triples designed together and from nothing else recoloring. Dark mode is not decided here; when it lands, each theme gains its dark triple beside its light one.
14. **Grouped vs individual actions (issue 5, §2).** What drives grouping — the source container, a shared project association, an AI suggestion, or a manual merge? *Recommendation: default to individual Items; let AI suggest a group when several open items share both their source container and their project association, with manual group/ungroup as the override. A group renders as one card with a count and expands in place.*
15. **Notification-class email (issue 6, §2).** *Recommendation: classify on ingest (sender and header heuristics plus AI); keep notification-class items out of the Inbox in a collapsible Notifications feed; where a notification maps onto an existing Item or a Panel's live rule, apply it as a state-change signal instead of a new item. Escalate into the Inbox only when personally directed and actionable — an assignment, a mention, an invite needing a response.*
16. **Payments — how is "paid" detected (issue 7, §2)?** *Recommendation: manual mark-as-paid in v1, with AI-detected confirmation emails as a suggested (not automatic) match; bank or accounting reconciliation (e.g. Billit) as a later connector.*
17. **Reading digest — topics of interest and leftovers (issue 8, §2).** How are topics defined, what happens to unread highlights, and is the panel continuous or daily? *Recommendation: a short manual topic list per Workspace refined by click-through behavior later; age highlights out of the panel after a few days but keep the emails searchable; compose the selection once per day so it reads as "today's picks" rather than another growing feed.*
18. **Reconciliation cadence and disappeared-item behavior (issue 9, §2, and §10.1).** *Recommendation: push where available plus polling on app focus and every few minutes while open; completed-at-source auto-completes with an undo trail; deleted-at-source removes it from panels but keeps it findable with a "removed at source" marker. Add confirmation prompts only if silent resolution bites.*

## 13. Scope per iteration (proposed)

**Iteration 1 — follow-up tracking:** Workspaces, Dashboards and Panels (move/resize/title) with plain-English rule configuration (§6.2); the Item model with associations; read-only Gmail/Slack/Notion connectors limited to flagged and assigned items; fast capture of internal notes (issue 2, §2); Project, Person, Topic, Focus and Highlights panels; the four Focus horizons with overdue escalation; per-item AI summaries, next-action labels and suggested tags; local-first offline viewing with queued actions; source reconciliation (§10.1).

**Iteration 2 — unified inbox:** the same connectors widened to the full stream; the To-Process triage inbox with swipe-left delete and assign/status (§5); reading and replying in the app; flag-for-follow-up feeding the iteration 1 dashboards; notification-class email routing (#15); Payments due and Reading digest panels.

**Later:** two-way sync beyond replies; Linear and Calendar; Chrome and YouTube; Kanban and calendar panels; end-of-period roll-up reminders; multi-user billing and onboarding.

## 14. Glossary

- **Account** — the person or organization Cockpit holds work for, and the outermost boundary: everything belongs to exactly one, and nothing is shared between two. Each User has one. Not the *source accounts* (a Gmail login, a Slack workspace) a Workspace connects to. The **register** is the list of which Accounts exist, who the Users are and who is signed in; it is what says an Account is real before any of its data is opened.
- **Workspace** — top-level context inside an Account and the privacy boundary (Work, Personal, Customer 1…); defines which sources are connected.
- **Dashboard** — a switchable named view inside a Workspace, holding a layout of Panels.
- **Panel** — a movable, resizable, titled box on a Dashboard displaying a filtered set of Items. Its title is unique within its Dashboard.
- **Layout** — one arrangement of a Dashboard's Panels — their order and each one's size — together with the screen width it was made at. A Dashboard can have several, so it reads well on a phone and on a 4K screen; the app draws it with the one closest to the screen in front of you unless you pick another.
- **Inbox** — the one place in a Workspace holding what has arrived and not been dealt with. Beside the Dashboards rather than one of them, and never renamed or deleted.
- **Item** — the single object everything is stored as, whether it arrived from a source or was created in the app. **Action** and **Thought** are *types* of Item, not separate objects.
- **Action** — an Item representing something to do. One source Item can produce several.
- **Thought** — an Item created in the app as a note or idea, with no source behind it.
- **Association** — a link from an Item to a Person, Project, Topic or Focus flag; many-to-many, which is why an Item can appear in several Panels.
- **Capture** — creating an Item directly in the app instead of receiving it from a source.
- **Status** — where an Item stands: To Process, Task, Waiting, Snoozed, Delegated, Reference, Done, Dismissed.
- **Snooze** — hiding an Item until a chosen date, after which it returns.
- **Priority** — low / normal / high importance, independent of the Focus horizon.
- **Next action** — the short, always-editable label describing what to actually do about an Item.
- **Focus horizon** — Today / This Week / This Month / This Quarter, date-anchored so it escalates to overdue.
- **Triage / process** — assigning associations and a status so an Item leaves the To-Process inbox. (Interim: until Panels hold Items, a triaged Item stays in the Inbox showing its new status — see the interim note in "The Inbox and the triage flow" (§5).)
- **Offline** — working from the local copy when the connection is not there. Cockpit opens, shows what it already holds, and takes what you capture and triage; those changes queue and go up on reconnect. Nothing new arrives from a source until the connection is back, and what the copy shows is said to be as old as it is rather than presented as current ("Offline / local-first behavior", §10).
- **User** — a person who uses this Cockpit. Each User owns one Account, which is what makes two Users' work separate. A User has a **Role**.
- **Role** — *user* or *admin*. Carried today and enforced nowhere; the first admin-only part of the app brings the check with it.
- **Sign in** — saying which User you are. Today by choosing a name on the **logon page**, which proves nothing and is meant not to; passwords and Google sign-in replace that step later. A sign-in lasts a set time, renews while used, and expires on its own, and Cockpit says so rather than failing at you.
- **Sign out** — ending a sign-in deliberately. Cockpit forgets it and the browser is left holding nothing of what you were looking at.

Four things the app does in the same way wherever it does them, named here because a shared behaviour with no word is one nobody can say is tested (`tools/test-explorer/concepts.json`):

- **Menu** — the control a row's actions open from, three dots wherever it appears. An action that cannot be taken stays in the menu, unavailable, saying why, rather than disappearing.
- **Deleting** — asking before anything goes, in a dialog naming what is going and what goes with it, offering Cancel and Delete in that fixed order. Escape and Cancel are the two ways to say no.
- **Ordering** — putting rows in the order you choose, by dragging one or by moving it a step at a time from its own menu; the two are the same move.
- **Live updates** — a change made in one place reaching everywhere else it is shown, without a reload.

This glossary is binding on anything written to be read as a description of the product, test names included (see `docs/testing-strategy.md`, "Tests are named in the product's language"). Words that live only in `docs/architecture.md` — command, envelope, tombstone, idempotency, last-write-wins — are implementation and stay there.
