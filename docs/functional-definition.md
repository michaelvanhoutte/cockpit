# Unified Inbox & Dashboards — Functional Definition (v0.7)

*Working title: TBD. Owner: Michael. Status: draft for refinement.*

## 1. Purpose

One application that aggregates what currently lands in many separate apps (email, Slack, Notion, later Linear, Calendar, Chrome, YouTube), so no app has to be checked individually. It does two jobs, delivered as two iterations ("Two iterations", below):

1. **Overview** (iteration 1): configurable dashboards of movable, titled panels surfacing everything flagged for follow-up, organized by project, person, topic and priority.
2. **Process** (iteration 2): a unified triage inbox where new items from every source arrive as "things to deal with", and each one gets read, reacted to, or flagged for follow-up (which feeds the iteration 1 overview).

The goal is to replace today's manual Notion setup with something faster to scan and triage, structured around *your* contexts (work, home, each customer, each project) rather than around which app a message came from.

### 1.1 Two iterations

The split follows where the pain is largest: forgetting things already decided on hurts more than reading messages in separate apps.

**Iteration 1: follow-up tracking ("never lose a flagged item").** Only explicitly marked items are ingested — an email flagged in Gmail, a Slack message saved for later or an actionable @mention, a Notion action or comment assigned to me — and shown on the dashboards. The source apps remain where messages are read and answered. This needs the container hierarchy and Item/Association model, dashboards with Panels and action cards, Focus horizons and deadline colors, AI next-action labels and suggested associations, read-only connectors limited to flagged items, and reconciliation so items completed or removed at the source disappear here too. Fast capture (problem 2) belongs here too: a quick idea is a follow-up item without an external source.

**Iteration 2: unified inbox ("read and process everything here").** All emails and messages become readable in one place, where each item can be read, replied to, or flagged to handle later. Adds full-firehose ingestion, the To-Process triage flow, notification-email routing (problem 6), and the panels that need all mail rather than only flagged mail: Payments due (problem 7) and the Reading digest (problem 8).

In one sentence: iteration 1 tracks what was already flagged; iteration 2 brings the flagging, reading and replying into the app.

## 2. Problems this product must solve

The concrete pains with today's way of working (a manual Notion board beside each tool). Every design choice below should be checked against them. Each is tagged with the iteration ("Two iterations", above) that addresses it.

1. **No single overview of everything to follow up on.** *(Iteration 1.)* The main problem. Items needing a reply are spread across tools, and the only overview today is manual double work — adding a Notion item so a Slack message is not forgotten. (Addressed by the Item model, with flagged items routing straight to the dashboards; the full triage flow follows in iteration 2.)
2. **Capturing a simple idea takes too much time.** *(Iteration 1.)* Logging a quick idea costs too much friction, which is why `c:\github\task-creator` was built as a stopgap; it should merge into this project as the fast capture path.
3. **Categorizing items is too much work, so it doesn't happen.** *(Iteration 1.)* The result is one Notion block holding a long mixed pile that grows until items get lost. Structure is wanted, but structuring must cost almost no effort. (Addressed by AI-suggested associations.)
4. **"Today / this week" markers silently rot.** *(Iteration 1.)* Unfinished items keep their markers, so days later things are still colored "today" with a deadline in the past. Priority markers must be date-anchored and escalate on their own. (Addressed by Focus horizons.)
5. **The overview must not become a mess: some items group, others must stay individual.** *(Iteration 1.)* Several Notion comments about one project probably belong together as one entry; five MT-meeting actions each about a different project must stay separate. What drives that is undecided — open decision #14.
6. **Automated notification email drowns out the mail that matters.** *(Iteration 2.)* Notion updates, meeting invites, GitHub activity and monitoring digests flood the inbox, but disabling them at the source loses information the app may want as a signal. So the noise must not clutter the inbox by default while staying available on demand and as machine-readable input. Routing is open decision #15.
7. **No overview of payments still to make.** *(Iteration 2.)* Invoices, payment requests and renewal notices arrive mixed in with everything else. One overview should list every email-derived item involving an unmade payment, with amount and due date where extractable, dropping off once paid. (Addressed by a Payments panel, fed by AI classification; detecting "paid" is open decision #16.)
8. **Technology and research email is unreadable at its volume, so none of it gets read.** *(Iteration 2.)* Reading this class item-by-item is the wrong model. Instead: a panel of highlights distilled from those emails on the topics I care about, so each day shows a short selection worth reading and the rest can be ignored. Unlike problem 6's notification noise, this mail is content to consume, not a signal. (Addressed by a Reading digest panel, fed by topic extraction; open decision #17.)
9. **A local copy is needed for speed and offline use, but it can drift out of sync.** *(Iteration 1, growing in iteration 2.)* The main driver is rendering speed — a dashboard cannot query Gmail, Slack and Notion live on every refresh — with offline viewing largely a byproduct. The hard problem is staleness: showing work that no longer exists destroys trust in the overview faster than missing items do. Changes at the source (removed, completed, edited) must flow back without double bookkeeping. (Addressed by reconciliation; cadence is open decision #18.)

## 3. Decisions already made

- **Delivery — two iterations.** Iteration 1 tracks items flagged at the source; iteration 2 adds the read-and-process inbox on top ("Two iterations", above). The data model does not change between them.
- **Audience — personal-first, SaaS-ready.** Built for one person first, with a data model, tenancy and auth that could become a multi-tenant product without a rewrite. **There is now more than one User**, each in an Account of their own ("Sign in by picking a name, each user in their own account", issue 86), and each signing in with their Google account ("Sign in with Google, and retire the list of names", issue 196). So the tenancy the schema always carried is exercised rather than assumed, and what separates two people's work is a sign-in rather than a claim. Never hard-code how many Accounts exist into the schema.
- **Offline — local-first.** Syncing happens online, but the app must open, show current status, read synced items and triage them without a connection; offline changes queue and reconcile on reconnect. Per problem 9, instant rendering is the primary purpose and offline use should fall out of the cache design rather than drive machinery of its own.
- **Inbox — triage queue.** The Inbox lists what has arrived and not been dealt with, not a permanent mirror of every message. **What decides is filing**: an Item filed on a Panel has left the Inbox and is visible in every Panel holding it ("Panels hold the items filed into them, and the Inbox holds the rest", issue 36). What an Item *is* — its Type — is separate from which list it is in.
- **v1 sources — Gmail, Slack, Notion.** Linear, Google Calendar, Chrome (bookmarks/downloads) and YouTube (saved videos) are later phases.

## 11. Non-functional requirements

- **One menu, however it opens.** Every menu in the app — a row's, a tab's, a Panel's — offers the same shape: same entries, same look, same rule that an entry that cannot be chosen stays visible and says why ("Open every menu from the same control", issue 115; "Change a workspace or a dashboard on the tab it is", issue 267). A row — the header, an Inbox row — opens its by the same control every time it appears: a vertical triplet of dots, one size, one hover and focus treatment, drawn rather than typed because `···` is punctuation whose size and baseline belong to the font, carrying its own name for whoever is not looking at it. Three dots therefore always mean a menu, never a link that navigates. A tab or a Panel opens its own instead — right-click, a long press, or the keyboard's own menu key — because the tab or the Panel itself is already the trigger.
- **Responsive UI** — desktop layouts use the full screen (dense rows of several Panels across, not a narrow centered column); mobile reflows to a single-column, touch-and-swipe layout.
- **The app fits the screen it is on.** On a phone with a notch the page runs edge to edge, so the Workspace's own colour reaches the top of the screen instead of a letterbox in one fixed colour — and nothing readable or pressable is left under the status bar, the home indicator or the rounded corners.
- **Installable PWA** (or native shell) for offline use and mobile gestures.
- **SaaS-ready architecture** — every row scoped to an account, now actually exercised by more than one; OAuth-based auth, which a User signs in with; per-user encrypted storage of source tokens.
- **Security & privacy** — source credentials encrypted; workspace scoping enforced server-side, not just in the UI; clear handling of message content sent to any AI service.
- **Performance** — dashboards render from the local cache instantly; syncing happens in the background.

## 12. Open decisions (need your call — recommendations included)

*Notification-class email, how "paid" is detected and the Reading digest's topics concern the iteration 2 inbox and its panels and can stay open until that phase. The rest touch the shared model and are best decided before or during iteration 1.*

1. **One-way vs two-way sync.** Should archiving or marking done here change the source? *Recommendation: read-only in v1, two-way sync opt-in per connector later.* Highest-impact decision.
2. **Inbox-first vs direct routing ("How an Item reaches a box", above).** *Recommendation: hybrid — inbox by default, per-source rules for the obvious cases, with an "unseen" marker on auto-routed cards.*
3. ~~**Swipe-right meaning.**~~ *Settled: it opens the picker, and there is no short-versus-long split — see "Swipe-right — settled".*
4. ~~**Tasks — separate object or Item status?**~~ *Answered: neither. An Item has a **Type**, and a due date is a field — see "An item is either yours to deal with or finished with" (issue 154) and "Capture a thought or an action, and see which it is" (issue 155). All panels still share one model.*
5. **Auto-tagging trust level.** Applied automatically with undo, or suggested for confirmation? *Recommendation: suggest-and-confirm in v1; auto-apply once trusted.*
6. **AI location vs offline.** *Recommendation: generate on sync in the cloud, cache the result so it reads offline.*
7. **Multi-workspace items.** *Recommendation: one primary Workspace per item to keep the privacy boundary clean; use Topics/Projects for cross-cutting.*
8. **Kanban in v1 or fast-follow?**
9. **Reminders/notifications channel.** Push (PWA), email, both? Needed for the "Focus and Goals" reminders, above.
10. **Reply detection / round-trip ("action cards", above).** *Recommendation: prompt on return in v1, sync-detection later. Depends on decision #1.*
11. **Action-label generation ("action cards", above).** *Recommendation: AI drafts, you edit; store both the original subject and your label so nothing is lost.*
12. **Live panels — de-dup and inbox interaction ("What a Panel shows", above).** Do matching items also hit the Inbox, and how is panel clutter avoided? *Recommendation: reuse the "inbox yes/no per rule" flag from "How an Item reaches a box", above; an item can appear in several panels but stays a single object, so acting on it once updates it everywhere.*
13. **Workspace colors.** **Answered: auto then user-picked.** A new Workspace gets the first color no other Workspace is using, so it never exists without an identity and nobody is asked for one to create it; the form its own tab opens then offers swatches to change it. What is picked is a **theme of four colors** ("Container hierarchy", above), all four stored on the Workspace, so a free color wheel later is a second writer of the same fields rather than a migration — and the fourth is stored rather than mixed from the two it sits between, so an entry stays tunable by hand. Legibility comes from the palette being fixed sets designed together and from nothing else recoloring. Dark mode is not decided here; when it lands, each theme gains its dark set beside its light one.
14. **Grouped vs individual actions (problem 5).** What drives grouping — the source container, a shared project association, an AI suggestion, or a manual merge? *Recommendation: default to individual Items; let AI suggest a group when several open items share both their source container and their project association, with manual group/ungroup as the override. A group renders as one card with a count and expands in place.*
15. **Notification-class email (problem 6).** *Recommendation: classify on ingest (sender and header heuristics plus AI); keep notification-class items out of the Inbox in a collapsible Notifications feed; where a notification maps onto an existing Item or a Panel's live rule, apply it as a state-change signal instead of a new item. Escalate into the Inbox only when personally directed and actionable — an assignment, a mention, an invite needing a response.*
16. **Payments — how is "paid" detected (problem 7)?** *Recommendation: manual mark-as-paid in v1, with AI-detected confirmation emails as a suggested (not automatic) match; bank or accounting reconciliation (e.g. Billit) as a later connector.*
17. **Reading digest — topics of interest and leftovers (problem 8).** How are topics defined, what happens to unread highlights, and is the panel continuous or daily? *Recommendation: a short manual topic list per Workspace refined by click-through behavior later; age highlights out of the panel after a few days but keep the emails searchable; compose the selection once per day so it reads as "today's picks" rather than another growing feed.*
18. **Reconciliation cadence and disappeared-item behavior (problem 9, and "Staleness and reconciliation", above).** *Recommendation: push where available plus polling on app focus and every few minutes while open; completed-at-source auto-completes with an undo trail; deleted-at-source removes it from panels but keeps it findable with a "removed at source" marker. Add confirmation prompts only if silent resolution bites.*

## 13. Scope per iteration (proposed)

**Iteration 1 — follow-up tracking:** Workspaces, Dashboards and Panels (move/title, on rows you size) with plain-English rule configuration ("What a Panel shows", above); the Item model with associations; read-only Gmail/Slack/Notion connectors limited to flagged and assigned items; fast capture of internal notes (problem 2); Project, Person, Topic, Focus and Highlights panels; the four Focus horizons with overdue escalation; per-item AI summaries, next-action labels and suggested tags; local-first offline viewing with queued actions; source reconciliation ("Staleness and reconciliation", above).

**Iteration 2 — unified inbox:** the same connectors widened to the full stream; the triage inbox with its swipes and filing; reading and replying in the app; flag-for-follow-up feeding the iteration 1 dashboards; notification-class email routing (#15); Payments due and Reading digest panels.

**Later:** two-way sync beyond replies; Linear and Calendar; Chrome and YouTube; Kanban and calendar panels; end-of-period roll-up reminders; multi-user billing and onboarding.

## Where this now lives

What each area does, split by topic:

- [Accounts](product/accounts.md)
- [Workspaces](product/workspaces.md)
- [Items](product/items.md)
- [Inbox](product/inbox.md)
- [Dashboards](product/dashboards.md)
- [Across the app](product/across-the-app.md)
- [Offline](product/offline.md)
- [Glossary](product/glossary.md)

Design — how the app looks — is `design-system.md`, not this document.

Routing and text learning stay where they are: [routing-learning.md](routing-learning.md), [text-learning.md](text-learning.md).
