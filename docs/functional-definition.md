# Unified Inbox & Dashboards — Functional Definition (v0.3)

*Working title: TBD. Owner: Michael. Status: draft for refinement.*

## 1. Purpose

A single application that aggregates everything that currently lands in many separate apps (email, Slack, Notion, and later Linear, Calendar, Chrome, YouTube) into one place, so you no longer have to check each app individually. It does two jobs:

1. **Process** — a unified triage inbox where new items from every connected source arrive as "things to deal with," and where you decide what each one becomes.
2. **Overview** — configurable dashboards of movable, titled panels that surface the highlights you need to follow up on, organized by project, person, topic, and priority.

The goal is to replace the manual Notion setup you use today with something faster to scan, faster to triage, and structured around *your* contexts (work, home, each customer, each project) rather than around which app a message happened to come from.

## 2. Problems this product must solve

These are the concrete pains with the current way of working (a manual Notion board next to each separate tool) that motivated this project. Every design choice in the rest of this document should be checked against them.

1. **No single overview of everything to follow up on.** The main problem: items that need a reply or follow-up are spread across the different tools (my own notes, Notion, Slack, mail, and so on), and keeping an overview of all of them is hard. Today that overview only exists through manual double work: to not forget a Slack message, I manually add an item to my Notion board; to not forget to finalize one-on-one notes, I manually create yet another Notion item pointing at them. The purpose of this project is to handle everything from one place, so a Slack message or an unfinished note becomes a followable item without re-entering it anywhere. (Addressed by the Item model, §4.2, and the triage flow, §5.)
2. **Capturing a simple idea takes too much time.** When a quick idea comes up, actually logging it so it is not forgotten costs too much time and friction. This is why `c:\github\task-creator` was built as a stopgap; it should later be merged into this project as the fast capture path for creating internal Items (§4.2).
3. **Categorizing items is too much work, so it doesn't happen.** Intelligently categorizing items by hand is hard, and in practice it gets neglected. The result is one block on the Notion board holding a long mixed pile of items from many categories, which grows until individual items get lost in the list. Structure is wanted, but the structuring itself must cost (almost) no effort. (Addressed by AI-suggested associations, §8, feeding the association model, §4.2.)
4. **"Today / this week" markers silently rot.** Items get marked as a priority for today or this week, but when not all of them get done the markers stay as they are, because they still feel like the highest priority. Three or four days later items are still colored as "today" with a deadline days in the past, and the whole today/this-week indication has lost its meaning. Priority markers must be date-anchored and escalate to overdue on their own instead of relying on manual re-coloring. (Addressed by the Focus horizons with overdue escalation, §7.)
5. **The overview itself must not become an unmanageable mess: some items should be grouped, others must stay individual.** A single source can fan out into many actions. A Notion page can produce a whole bunch of comments assigned to me that are all about the same project; those probably belong together as one grouped entry. But five actions assigned to me out of one MT meeting may each concern a different project, and those I want to see as separate actions. So some actions should be shown individually and others grouped, and it is not yet clear what should drive that. Recorded as open decision #14 (§12).
6. **Automated notification email drowns out the mail that matters.** Keeping up with email is hard today, in large part because the inbox is flooded with machine-generated notifications: Notion updates, meeting invites, GitHub activity, monitoring digests, and so on. They make me lose the forest for the trees. Simply disabling those notifications at the source is not always a solution, because they sometimes do contain useful information, and this product may even want to consume them as signals to detect changes relevant to a project or item. The requirement is therefore twofold: this noise must not clutter the inbox by default, but the information in it must stay available, both to me on demand and to the app as machine-readable input. How exactly to classify and route them is recorded as open decision #15 (§12).

## 3. Decisions already made

These four decisions are settled and everything below is built on them:

- **Audience — personal-first, SaaS-ready.** Built for you as the first and only user for now, but the data model, tenancy, and auth are designed so it could become a multi-tenant product later without a rewrite. In practice this means: assume a single user today, but never hard-code that assumption into the schema.
- **Offline — local-first.** Syncing with the source apps happens while online. But you must be able to open the app and see your current status, read already-synced items, and triage them *without* a live connection. Changes made offline queue locally and reconcile when connectivity returns. (This is "local-first," not "never touches the network.")
- **Inbox — triage queue.** The Inbox is a list of *items still to process*, not a permanent mirror of every message. Once you process an item it leaves the Inbox, though it remains visible in whatever panels its associations feed.
- **v1 sources — Gmail, Slack, Notion.** Linear, Google Calendar, Chrome (bookmarks/downloads), and YouTube (saved videos) are explicitly later phases.

## 4. Core concepts and terminology

This is the part that resolves most of the ambiguity in the original notes. Everything in the app is built from two structures: a **container hierarchy** and an **item model**.

### 4.1 Container hierarchy (resolves "dashboard vs workspace")

Three levels, top to bottom:

**Workspace** — the top-level context and the privacy boundary. Examples: *Work*, *Personal*, *Home*, *Customer 1*, *Customer 2*. A Workspace controls **which source accounts are connected and visible**, so when you are in the *Work* workspace you do not see private email, and vice versa. This is the "I don't want to see private emails while processing work stuff" requirement, solved by scoping rather than by filtering after the fact. (Original notes called this level "dashboard" and were unsure; "Workspace" is the recommended name.) Each Workspace also has its own **color identity**: the UI chrome (header, accents, panel borders) tints to that color so it is always obvious at a glance which Workspace you are currently in.

**Page** — a named view *inside* a Workspace. A Workspace has several Pages you switch between, like tabs. Example Pages inside *Work*: a landing Page showing today's to-dos; a *Dormant projects* Page; a *Research* Page. (This is your "multiple pages" idea.)

**Panel** — a movable, resizable, titled box on a Page. Each Panel is a **saved, filtered view of items** (see below). Example Panels: a *Project X* box, a *People* box, a *Research* box, a *Focus: This Week* box, a Kanban board. Every Panel has a user-editable title.

So the full path to any box is: `Workspace → Page → Panel`.

```
Workspace: "Work"
├── Page: "Today"            ← landing page
│   ├── Panel: "To Process"  (the inbox view, scoped to Work)
│   ├── Panel: "Focus Today"
│   ├── Panel: "Project Falcon"
│   └── Panel: "People to talk to"
├── Page: "Dormant projects"
│   └── Panel: "On hold"
└── Page: "Research"
    └── Panel: "To read"
```

### 4.2 Item + Association model (resolves "one message in two inboxes")

Everything that flows in — an email, a Slack message, a Notion page, later a calendar event or a bookmark — is normalized into a single object called an **Item**. An Item stores: source app (or *internal* when you created it in the app yourself), source ID, a deep link back to the original, sender/author, timestamp, title/subject, a text preview/body, an optional priority/importance level, an optional due date, and its own status. Not everything originates externally — you can create native notes and to-dos directly in the app; those simply have no source app and open inside the app rather than deep-linking out.

Items are **not filed into one folder.** Instead, each Item carries any number of **Associations**:

- links to one or more **People**
- links to one or more **Projects**
- links to one or more **Topics/Areas** (e.g. *Research*, *People to discuss*)
- a **Workspace** it belongs to (can be more than one if a message is both work and personal, though that should be rare)
- optional **Focus** flags (see §7)
- a **processing status** (§5)

Because associations are many-to-many, one message can appear simultaneously in the *Project Falcon* panel **and** the *Anna (person)* panel without being duplicated or moved. This directly answers "I don't want every message to only appear in a single inbox." A Panel is simply a query over Items ("show items associated with Project Falcon, not yet done"), so the same Item naturally shows up in every Panel whose filter it matches.

**Tasks vs Items (recommendation):** treat a to-do as an Item (or a small object attached to an Item) that has been given a *status of "task"* plus optional due date — not a separate silo. That way a Kanban board, a to-do list, and the inbox are all just different Panels over the same underlying Items.

## 5. The Inbox and the triage flow

The Inbox is a Panel type showing every Item with status **To Process**, scoped to the current Workspace (so no private items while processing work).

When you process an Item you do one or more of:

- **Associate it** — tag it to a Person, Project, and/or Topic. This is what makes it show up in the right dashboard panels.
- **Set a status** — e.g. *Done*, *Waiting on someone*, *Scheduled/Snoozed until a date*, *Delegated*, *Reference/Archive*, or *Convert to Task* (with a due date).
- **Delete/Dismiss** — remove it from the queue.

Once it has a status other than *To Process*, it leaves the Inbox but stays reachable through its associations and through an optional "All items" view.

**Gestures and interactions:**

- **Swipe left = delete/dismiss** (your stated example).
- **Swipe right = file into a box** — the candidate meaning (see §5.2 for the full set of options).
- On desktop, the same actions are available via buttons, keyboard shortcuts, and drag-into-panel.

**Open question worth flagging now:** does "delete" mean delete only inside this app, or also archive/delete in Gmail/Slack? See §12 — this is the single biggest behavioral decision.

### 5.1 How an Item reaches a box — must it pass through the Inbox first? (undecided)

The reframing that makes this tractable: **"in the Inbox (still to process)" and "shown in a box (has an association)" are two independent states, not two ends of one pipeline.** Because associations are many-to-many and status is separate (§4.2), an Item can be in the To-Process queue, or shown in a box, or both, or neither. So whether something "passes through the inbox first" is a *default/rule* choice per source, not a fixed architecture. Two models to keep on the table:

**Model A — Inbox-first (manual triage).** Everything lands in To Process. Nothing appears in a Project/Person/to-do box until you deliberately file it there. Swipe-right (or drag) is how you place it.
- *Pro:* one point of control; nothing shows up in a box you didn't consciously put there.
- *Con:* even obvious items (you're @mentioned on a customer project; you deliberately saved a message to a customer channel) still make you do manual work to route something whose destination is already clear.

**Model B — Direct routing by rule (skip the inbox when the destination is known).** Rules send certain items straight to the relevant box without hitting To Process. Examples: "Slack messages in the #customer-1 channel → Customer 1's board," "@mentions on a project → that project's box," "anything I explicitly save/star → its box." This is the case you raised — the item shows up on the to-do list in the right box without being triaged first.
- *Pro:* far less busywork for high-signal items; the app feels like it already knows where things go.
- *Con:* items can appear in boxes without a conscious review step; you need a way to still notice them (e.g. an "unseen" dot on auto-routed cards, or a per-rule "also show in Inbox" toggle).

**A useful distinction inside Model B — passive vs active capture:**
- *Passive* (you got tagged/@mentioned): a rule can route it, but you probably still want a light review, so "route to the box **and** flag as unseen" fits.
- *Active* (you deliberately saved/bookmarked a Slack message in a customer channel): a strong, intentional signal — this one likely should go **straight to that customer's box/to-do and skip the Inbox entirely**, since you already decided.

**Recommended lean (a hybrid).** Keep the Inbox as the default for anything with no matching rule, but let you define per-source/per-channel routing rules so obvious and actively-saved items land directly in a box (optionally still marked "unseen" until you glance at them). This keeps Model A's safety for the ambiguous stuff and Model B's speed for the obvious stuff, without committing to either extreme. Decision still open — recorded here so we don't lose it.

### 5.2 Swipe-right — options to keep in mind (undecided)

We have swipe-left = delete. Candidate meanings for swipe-right, to be tested rather than decided now:
- **File into a box** — swipe-right opens a picker (or repeats the last-used box) to assign the Item to a Project/Person/to-do box. Your latest idea. Best if Model A (inbox-first) dominates.
- **Quick process sheet** — swipe-right opens an action sheet to assign associations *and* set status in one gesture.
- **Snooze / defer** — swipe-right pushes the Item out of the queue until a chosen date.
- **Mark done** — swipe-right resolves it outright.

These aren't mutually exclusive: a short swipe-right could do the primary action (file into a box) while a long swipe or a second gesture handles snooze/done. Worth prototyping on the phone before locking in.

## 6. Dashboards: Pages and Panels

**Panels** behave like the tiles on Azumuta's Analytics dashboards (the reference model): each sits on a grid, you **drag to move** it and **drag a corner to resize** it, every tile has an editable **title** and a per-tile **"..." menu** (configure, rename, remove), and a **"+"** adds a new Panel to the Page. A responsive grid layout reflows the tiles on smaller screens so the same Page works on phone and desktop. Page-level controls (date range, share, fullscreen) can follow the same pattern where useful.

Recommended **Panel types** for v1:

- **To Process** — the inbox/triage queue (§5).
- **Project** — all Items associated with a given Project, across all sources. This is your "a box about a project shows my Notion, Slack, and emails about that project."
- **Person** — Items and notes tied to a person; doubles as "things I need to discuss with this person."
- **Topic/Area** — a free-form bucket such as *Research* or *People to discuss*.
- **Focus** — Items flagged for Today / This Week / This Month / This Quarter (§7).
- **Highlights / AI summary** — an auto-generated digest (§8).
- **Kanban** *(candidate for v1 or fast-follow)* — Items as cards in columns you define (e.g. To do / Doing / Waiting / Done).
- **Calendar/agenda** *(later, with the Calendar integration)*.

A **Page** is just a saved arrangement of Panels; you can have as many Pages per Workspace as you like and switch between them.

### 6.1 How Items render in a Panel — action cards

Any Panel can present its Items as a to-do / action list rather than raw message previews. This is a **general Panel capability**, not tied to any single use case — a per-customer list, a project list, a personal errands list, a research reading list all use the exact same card mechanics. (A customer-categorized list is just one example of how you might configure a Panel, not a special panel type.) Each card has:

- A **next-action label** — a short, distilled summary of *what really needs to be done*: *"Answer pricing question,"* *"Reply to Tom's question on Part 11 compatibility."* This is important and non-trivial: the required action is usually **not** simply the Slack message or the last email — it has to be inferred from the whole thread/context. So this is genuine LLM work (action extraction, §8), not a copy of the subject line or latest message. For internal notes you write the line yourself. Either way it is **always editable** so you can correct or sharpen what the AI produced.
- A **source icon** — mail, Slack, Notion, or an "internal note" marker, so you can see at a glance what is driving the item (rendered like *"Answer pricing question (mail)"*).
- **Deadline color** (§7.1) and a **priority/importance** highlight — cards can be emphasized by priority, independent of any deadline.

Panel-level controls over that list, all of which any Panel supports:

- **Manual sort** — drag cards to reorder them by hand; the Panel remembers the order.
- **Categorization / grouping** — group cards by any field (person, project, status, priority, or e.g. by customer). Titles and groupings are yours to set.
- **Highlighting** — emphasize cards by priority/importance and by deadline (§7.1).

**Where a card links.** Clicking a card opens the right thing depending on where the item came from:

- **From a connected source** → it deep-links into that app at exactly the right place (the Gmail thread, the Slack message, the Notion page), so you act in the real tool rather than a degraded copy.
- **An internal note/to-do created in this app** → it opens inside this app for viewing and editing. Not everything originates externally; you can create native items directly in a Panel or the Inbox.

**The round-trip — updating the card after you replied elsewhere.** Once you act in the source app, the card has to update, and the outcome is not always "done":

- If your reply fully resolves it → mark **Done**; the card leaves the Panel (or shows as completed).
- If you replied but now need to make sure something happens (you are awaiting their answer or a result) → the item moves to a **Waiting / Follow-up** state, it **stays** in the Panel, and its next-action label **rewrites itself** to the new step: *"Reply to Tom's question on Part 11"* becomes *"Follow up: awaiting Tom's answer on Part 11."*

So each Item carries a *current next-action* that is state-dependent: resolving one action either closes the item or advances it to a follow-up state with a new action. How the app learns you replied is an open decision (§12.10) — detect the outbound reply via two-way sync, or prompt you ("Handled? → Done / Waiting / Still to do") when you return to the app after a click-through. Recommended: prompt on return in v1, add sync-detection later.

### 6.2 What a Panel shows — manual promotion + live rules

A Panel's contents come from two mechanisms that combine:

- **Manual promotion.** You can promote any Item from the Inbox (or anywhere) into a specific Panel — the explicit "file into a box" action (§5.2).
- **Live rules (saved queries).** A Panel can be *configured* with a rule for what belongs in it, e.g. "all messages from the **cust-AtlasCopco** Slack channel," "emails labelled *Pricing*," or "Items associated with Project Falcon." When set, the Panel **remembers** the rule (optionally) and any future item matching it **appears automatically** — so the next message posted in that channel shows up without you touching the Inbox. This is the panel-level expression of the direct-routing idea in §5.1.

**Attach-and-monitor scope prompt.** When you add a Slack item to a Panel, the app should ask *how much* to monitor, because "this message" and "this whole channel" are very different intentions:

- **This thread** — just this message and its replies.
- **This conversation / DM** — the whole 1:1 or group chat.
- **This channel** — every future message in the channel (the live-rule case above).

The same idea generalizes to other sources (a single email thread vs a whole label/folder; a single Notion page vs a database). The scope you pick becomes the Panel's live rule.

## 7. Focus and Goals (time-horizon priorities)

You can flag any Item or Task with a **Focus horizon**: **Today, This Week, This Month, This Quarter.** These are date-anchored, not merely colored, which is the key requirement.

Behavior:

- An Item flagged **Today** is anchored to today's date. If it is not completed by end of day, it automatically renders as **Overdue** the next day (not just "still today's color"). The same escalation applies to Week/Month/Quarter as each period ends.
- **End-of-period review.** As a month or quarter closes, the app surfaces a reminder/roll-up if too many Focus items for that period are still open ("You have 6 open items in this quarter's focus with 3 days left"), so nothing silently rolls over unnoticed.
- **How you set it.** Select one or more Items in any Panel and choose *"Add to This Week's Focus"* (your "Enable for Monthly Goal" idea), or set it from the Item's detail view. A dedicated **Focus Panel** shows what you have committed to for each horizon.

This turns the four horizons into an accountability loop rather than a static label.

### 7.1 Deadline color states

Independently of the Focus horizons, any Item can carry a hard **due date**, and cards are color-coded by proximity to it: neutral while there is time, **orange** once the deadline is reached (due today, or within a set threshold), and **red** once it has passed. This is the at-a-glance version of the escalation above, and it applies in every Panel the item appears in. Focus horizons (§7) and explicit due dates are related but not identical — a "This Week" focus flag anchors to end-of-week, while a due date is a specific date — but both feed the same orange/red treatment.

## 8. AI layer: executive summaries and highlights

Three levels of AI assistance:

- **Per-item / per-thread summary.** For long or technical messages, generate a short executive summary so you can triage without reading the whole thread. Your "automatically analyze tech messages and give me an executive summary" requirement.
- **Action extraction (the next-action label).** Read the full thread/context — not just the last message or the subject — and distill the single, concrete thing you actually need to do into one short line (§6.1). This is real LLM work: the required action is often not literally stated in the latest message. The result is always editable by you.
- **Suggested associations.** When an Item arrives, AI proposes the likely Project/Person/Topic tags and a suggested status, which you confirm or override. This makes triage much faster and is where most of the day-to-day value is.
- **Dashboard highlights digest.** A Highlights panel (and optionally a daily push) that says "here is what needs follow-up today" across all connected sources — the modern version of your Notion overview.

Where the AI runs (cloud vs on-device) interacts with the offline requirement — noted in §12.

## 9. Integrations and connections

**Connections are configured per Workspace.** Each Workspace declares which accounts/sources it pulls from (e.g. *Work* uses your work Gmail + company Slack + work Notion; *Personal* uses your personal Gmail). This is both the privacy boundary and the source filter.

- **v1:** Gmail, Slack, Notion.
- **Phase 2:** Linear, Google Calendar.
- **Phase 3 / ideas:** Chrome bookmarks & downloads, YouTube saved videos.

Each connector is responsible for: authenticating (OAuth), pulling new items on a schedule/push, normalizing them into the Item model, and (if two-way sync is enabled) pushing status changes back.

## 10. Offline / local-first behavior

- The app stores a local copy of synced Items, associations, panels, pages, and workspaces so it is fully **viewable and triageable offline**.
- **Reads offline:** open the app, see current status, read already-synced items, browse dashboards.
- **Writes offline:** triage actions (associate, set status, add to focus, delete) are captured locally and **queued**.
- **On reconnect:** queued changes sync to the backend and to source apps (where two-way sync applies); new items pull down. A simple conflict rule is needed (recommended: last-write-wins per field, with source apps treated as read-only unless two-way sync is explicitly enabled).
- New incoming messages obviously only arrive when online — offline means "the app still works with what it already has," per your clarification.

## 11. Non-functional requirements

- **Responsive UI** — must run on both desktop and mobile. On desktop, the layout should make full use of the available screen real estate (dense, multi-column panel grids rather than a narrow centered column); on mobile it reflows to a single-column, touch-and-swipe-friendly layout. The panel grid adapts per breakpoint.
- **Installable PWA** (or native shell) to support offline use and mobile gestures.
- **SaaS-ready architecture:** multi-tenant-capable schema (every row scoped to an account/tenant even though there is one tenant today), OAuth-based auth, per-user encrypted storage of source tokens.
- **Security & privacy:** source credentials stored encrypted; workspace scoping enforced server-side, not just in the UI; clear handling of message content sent to any AI service.
- **Performance:** dashboards should render from the local cache instantly; syncing happens in the background.

## 12. Open decisions (need your call — recommendations included)

1. **One-way vs two-way sync.** When you archive/delete/mark-done in this app, should it change the source (archive the Gmail thread, etc.), or only affect this app's view? *Recommendation: read-only in v1 (safest, simplest), with two-way sync as an opt-in per connector later.* This is the highest-impact decision.
2. **Inbox-first vs direct routing (§5.1).** Must every item pass through the To-Process inbox, or can rules send high-signal / actively-saved items straight to a box? *Recommendation: hybrid — inbox by default, per-source/channel rules for the obvious cases, with an "unseen" marker on auto-routed cards.*
3. **Swipe-right meaning (§5.2).** Candidates: file into a box, quick process sheet, snooze, or mark done. *Recommendation: short swipe-right = file into a box; long swipe or button for snooze/done. Prototype on phone before locking.*
4. **Tasks — separate object or Item status?** *Recommendation: Item with a "task" status + due date, so all panels share one data model.*
5. **Auto-tagging trust level.** Should AI-suggested associations be applied automatically (with undo) or only suggested for confirmation? *Recommendation: suggest-and-confirm in v1; auto-apply once you trust it.*
6. **AI location vs offline.** Cloud AI gives better summaries but needs connectivity; summaries can be generated at sync time and cached for offline viewing. *Recommendation: generate on sync (cloud), cache the result so it reads offline.*
7. **Multi-workspace items.** Can a single Item belong to more than one Workspace, or is Workspace strictly one-per-item? *Recommendation: one primary Workspace per item to keep the privacy boundary clean; use Topics/Projects for cross-cutting.*
8. **Kanban in v1 or fast-follow?** Listed as an idea; decide whether it ships in the first cut.
9. **Reminders/notifications channel.** Push (PWA), email, both? Needed for the focus/end-of-period reminders in §7.
10. **Reply detection / round-trip (§6.1).** How does the app know you replied in the source app — detect the outbound message via two-way sync, or prompt you on return from the click-through? *Recommendation: prompt on return in v1; add sync-detection later. Note this depends on decision #1 (two-way sync).*
11. **Action-label generation (§6.1).** Are next-action labels AI-drafted-and-editable or purely manual? *Recommendation: AI drafts, you edit; store both the original subject and your action label so nothing is lost.*
12. **Live panels — de-dup and inbox interaction (§6.2).** When a Panel has a live rule, do matching items also still hit the Inbox, and how do we avoid one item cluttering many panels? *Recommendation: reuse the §5.1 "inbox yes/no per rule" flag; an item can appear in several panels but remains a single object, so acting on it once (done, snooze, follow-up) updates it everywhere at once.*
13. **Workspace colors.** Auto-assigned from a palette or user-picked per Workspace? *Recommendation: user-picked with sensible defaults; ensure the palette stays accessible/legible in both light and dark mode.*
14. **Grouped vs individual actions (Issue 5, §2).** Several actions can come out of one source container (e.g. multiple Notion comments assigned to you on one page, all about the same project) and probably deserve to appear as a single grouped entry, while other same-origin actions (e.g. five MT meeting actions that each concern a different project) must stay separate cards. What drives the grouping is undecided: the source container, the shared project association, an AI suggestion, or a manual "merge these" action. *Recommendation: default to individual Items; let AI suggest a group when several open items share both their source container and their project association, and offer manual group/ungroup as the override. A group renders as one card with a count and expands in place. Revisit after real usage.*
15. **Notification-class email (Issue 6, §2).** How should machine-generated email (Notion updates, GitHub activity, meeting invites, monitoring digests, newsletters) be handled? It must not clutter the To-Process inbox, yet the information must remain reachable and usable as a signal. Candidate treatments: classify on ingest and route to a separate low-priority "Notifications" feed that never hits To Process; roll them up into a periodic digest (possibly the Highlights panel, §8); or consume them purely as signals that update the state of an existing Item or Panel (e.g. a GitHub notification marking a tracked issue as changed) without creating a new triage entry at all. *Recommendation: combine them. Classify on ingest (sender/header heuristics plus AI), keep notification-class items out of the Inbox by default in a collapsible Notifications feed, and where a notification maps onto an existing Item or a Panel's live rule, apply it as a state-change signal instead of a new item. Escalate into the Inbox only when a notification is personally directed and actionable: an assignment, a mention, or an invite that needs a response.*

## 13. MVP scope (proposed)

**In:** Workspaces + Pages + Panels (move/resize/title); Item model with associations; Gmail/Slack/Notion connectors (read-only); triage inbox with swipe-left delete and assign/status; Project, Person, Topic, Focus, and Highlights panels; the four Focus horizons with overdue escalation; per-item AI summaries + suggested tags; local-first offline viewing and queued triage.

**Later:** two-way sync; Linear + Calendar; Chrome + YouTube; Kanban and calendar panels; end-of-period roll-up reminders; multi-user/tenant billing and onboarding.

## 14. Glossary

- **Workspace** — top-level context and privacy boundary (Work, Personal, Customer 1…); defines which sources are connected.
- **Page** — a switchable named view inside a Workspace; holds a layout of Panels.
- **Panel** — a movable, resizable, titled box that displays a filtered set of Items.
- **Item** — any normalized piece of content from a source (email, message, page, event…).
- **Association** — a link from an Item to a Person, Project, Topic, or Focus flag; many-to-many, which is why an Item can appear in several Panels.
- **Focus horizon** — Today / This Week / This Month / This Quarter priority flag on an Item, date-anchored so it escalates to overdue.
- **Triage / process** — the act of assigning associations and a status to an Item so it leaves the To-Process inbox.
