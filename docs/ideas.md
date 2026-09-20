# Ideas Backlog

Raw feature ideas, captured as voice and WhatsApp notes between 17 August and 3 September 2026 and grouped by theme. A **capture list, not a plan**: nothing here is decided, sized or scheduled. Contradictions and overlaps with the [functional definition](functional-definition.md) are kept as written, because the wording is the record of what was wanted.

Terminology follows the functional definition. Notes since taken up in their own documents are marked where they appear, and kept so the origin of the requirement stays visible.

---

## 1. Panels and dashboard layout

- **Per-panel connection configuration.** Every Panel gets a "..." configuration option in which you can enable/disable which connections that Panel is allowed to use.
- **Per-panel plain-English description box.** Every Panel gets a multiline text box in which you type, in plain text, what information you want rendered there. Example: *"all saved actions related to customers, categorized per customer."* First step: add the box to the UI without wiring it up to anything yet. (Relates to the plain-English rule configuration below.)
- **Panel types and live rules.** *(Design decided, not built: a Panel of Items today only ever holds what is manually filed — see "Filing" in `docs/product/dashboards.md` — there is no query or classification behind one.)* A Panel could instead show Items matched by a **live rule** rather than filing: a saved query ("all messages from the cust-AtlasCopco Slack channel", "Items associated with Project Falcon"), configured in plain English and translated to the underlying query by AI, with the interpretation played back for confirmation. Adding a Slack item could ask *how much* to monitor — this thread, this conversation, this channel — the scope becoming the live rule. Candidate rule-driven panel types: **Project**, **Person** and **Topic/Area** (depend on Associations having a view, §12), **Focus** and **Payments due** (depend on Focus horizons, §13), **Highlights** and **Reading digest** (depend on the AI layer, §14), plus **Kanban** (cards in columns you define) and **Calendar/agenda**. A Panel of Items rendering as action cards — a next-action label, a source icon, deadline/priority highlighting, manual sort and grouping by field, a deep link into the connected source at exactly the right place (the thread, the message, the page) rather than a copy of it, and a round-trip that rewrites the label after you reply elsewhere — is the same idea at the per-item level.
- **A Filter that reaches further than one rule at a time.** **Reaching across Workspaces**, a Filter showing only what is filed in its own, is what the Filter Panel deliberately does not do; it would want the question to say which it means, which is a design rather than a setting. *(Design decided, not built: **sets of conditions joined by or**, for mixes like *(A and B) or C*. A Filter's all/any setting, built in "Let a Filter show items that meet any of its conditions" (issue 504), covers a flat list of conditions only.)*
- **Define the Gmail actions Panel.** Work out the concrete definition of the Panel that shows Gmail actions; it is the first consumer of the two configuration options above.
- ~~**A Panel that shows text**, in the variant whose whole contents are text.~~ *(Taken up by "Put a panel of text on a dashboard, and write in it" (issue 250), which adds the kind and the read-only choice, and "Format what a panel says, without making every dashboard pay for an editor" (issue 251), which answers the renderer cost below by drawing plain characters until somebody asks for formatting.)* **The second variant is still open**: a Panel of Items with text sitting between them. Neither is the plain-English description box above, which is configuration — what the Panel should render — rather than something read on the Dashboard.
- ~~**Fixed-size panels are probably not good enough.** Panels may have to resize.~~ *(Taken up by "Drag a row taller and a panel wider, on the dashboard itself" (issue 255): the line under a row sets how tall it is and the line between two Panels sets how much of the row each takes.)* **The related open question stands**: how do Panel positions change when the Inbox opens or closes?
- **Auto-resize on/off.** Give an option to auto-resize panels or not.
- **Highlight the destination.** When you click an Item in the Inbox, highlight the Panel or Panels that Item would be moved into.
- **Table view.** Support a table view next to the Panel view.
- **Zoom.** Support zooming in the Panel view.
- ~~**Configurable item types.** Add configurable types (e.g. *action* and *note*) that can be created and moved in a Panel, and render each type differently.~~ *(Taken up by "Capture a thought or an action, and see which it is" (issue 155), which makes the set open and draws each type in its own colour, and "Manage the types, and put them in the order you want" (issue 156). Moving one between Panels is filing, which "Drag an item into a panel, and drop it where you want it" (issue 141) and "Ask whether to move an item to a panel or add it to one" (issue 142) already cover.)*

## 2. Capture and the task creator

- **Remember the last project used**, and remember colour suggestions in a particular way.
- ~~**Task vs thought.** When creating an entry, let me choose between a *task* (something actionable) and a *thought* (not directly actionable).~~ *(Taken up by "Capture a thought or an action, and see which it is" (issue 155): capture asks what kind of thing it is, and the set is open rather than the two.)*
- **Guidance alongside a thought.** Let me set guidance next to a thought, e.g. *"the next few thoughts are likely about project X."*
- **Three cleaned-up phrasings.** Make three suggestions of cleaned-up text and let the LLM learn from my selections how I want the titles of my actions and notes phrased.
- ~~**Offer multiple interpretations.** When converting a short note into a longer, clearer message and there are several plausible readings, suggest the alternative meanings so I can pick the right one.~~ *(Taken up by "Offer the other readings when a captured note says two things" (issue 297): the same model call that cleans a note up also returns the other readings, where the note genuinely supports more than one.)*
- **Learn from triage.** Let the assignment skill learn from the tasks I move out of the Inbox. *(Now specified in [routing-learning.md](routing-learning.md), which treats the correction I make when moving an item out of the Inbox as the learning signal.)*
- ~~**Training window.** Use the last 100 notes for training, weighting the last 25 higher, and include tasks created in the UI through the chat button.~~ *(Partly taken up: "Cap the routing prompt to the last 50 decisions on panels that still exist, and drop the correction override" (issue 450) bounds the routing history similarly, tying relevance to whether the decision's Panel still exists rather than to a weighted recency window - see [routing-learning.md](routing-learning.md), "What the model reads: bounded, no retrieval". Tasks created through the chat button are not folded in.)*
- **Auto-read deadlines from emails.**
- **Global capture shortcut on Windows 11**, so a note can be logged without switching windows. Open question: is the same possible on Android, e.g. via the physical buttons on the right-hand side?
- **Create a Linear ticket from a thought.** (Overlaps with the commands layer, §3.)

## 3. Commands: drag-and-drop actions on external systems

The intended flow: log an action or a thought → it lands in the Inbox, or directly in the right Panel when that is obvious → from the Inbox or the Panel, drop it onto a command.

- **Custom commands.** Add the ability to define custom actions, e.g. "create a ticket in Linear in project X", and trigger them by dragging and dropping an action on top of them.
- **Create commands by describing them in chat.** Use the chat to create commands quickly by simply describing them. The command is written to the corresponding markdown file of the Cockpit project; if the right file is not obvious, ask me first which one to use.
- **Command bar.** Show commands in a command bar that can be shown or hidden, and reachable by right-clicking.
- **Age colouring.** Commands that have not been used recently are coloured differently.
- **Command history UI.**
- **Authentication skill.** Add a skill for commands that states which method is used to authenticate with each target system (Linear, Jira, Notion, ...) when authentication is needed.
- **Commands run as durable background jobs.** Example: a Command button that appends text to this project's `ideas.md`. Dropping a note on it starts the operation asynchronously so I can carry on immediately, which means the job must survive a crash or a restart rather than sitting in an in-memory queue.
- **Async task UI** showing every launched asynchronous task and its status, with enough detail to troubleshoot a failure and retry it. (Related to the command history UI above and to the operations items in §7.)
- **Show the agents that are running.** Show the active Claude, coding and other agents, not only the tasks Cockpit itself launched.
- **Run an agent on an Item.** Drag an agent or a command onto an action; that action then carries a small icon showing an agent is running on it.

## 4. Chat

- **Chat UI** to ask about the priorities of the day and to post further notes and actions. (Its captures feed the training set in §2.)

## 5. Item content

- ~~**Rich text** in the description of an action/note.~~ **Done**, in two: "Edit an item's title and description on a form of its own" (issue 159) gave the description somewhere to live, and "Format a description, and edit its source" (issue 160) formatted it. The decision and the measurements are in [rich-text-options.md](rich-text-options.md); buttons for headings, tables, code blocks and strikethrough are still to come, and embedding an image inline is the bullet below.
- ~~**Attachments** in the description of an action/note.~~ **Done**, on the Item's own form rather than inside the description: "Attach a file to an item" (issue 441). What is still open is embedding an attached image *inline inside the description*, which is now the one thing blocking the rich-text bullet above from being complete.

## 6. Search, archive and organisation

- **Search.**
- **Archive management:** the ability to archive items and to browse the archive.
- **Move items between Workspaces.** *(Captured as "move issues between workspaces"; needs clarification whether this means Cockpit Items across Workspaces or dev issues across issue-tracker workspaces.)*

## 7. Platform, users and operations

- ~~**Multiple users, staged.** Start without authentication: pick a name off the logon page, no password. Add OAuth and password support afterwards.~~ *(Done, both halves: "Sign in by picking a name, each user in their own account" (issue 86) and "Sign in with Google, and retire the list of names" (issue 196). Passwords are not coming — "App login" in [architecture.md](architecture.md) decides on Google and, for a guest, on nothing at all, which is what keeps password storage, reset flows and email verification out of the system entirely.)*
- ~~**Admin section for user management**: its own pages to delete a user, reset a password, and the rest of day-to-day administration.~~ *(Taken up by six issues, "Give the operator's routes the operator's name, and free /v1/admin/ for the admin section" (issue 229) through "Delete a user, and the account they owned with them" (issue 234): a page of its own behind the first role check, on which a user is added, renamed, promoted, disabled and deleted — the last taking their account with it, since an account is addressed by name and one left behind would be handed to whoever is added under that name next. No password to reset, per the bullet above.)*
- ~~**Roles from the start**, so role logic is in the code from the beginning rather than retrofitted.~~ *(Done as asked: every user carries `user` or `admin` since issue 86, and since "See who can sign in, on a page only an admin can open" (issue 230) the role decides who can open the admin pages — the bet that carrying it early would save retrofitting it, collected.)*
- **Multi-tenancy.**
- **Audit trail.**
- ~~**Backup.**~~ **Done**, in two: "Take a backup of an environment, or of one user" (issue 208) writes the register and every account's store to local JSON, and "Restore an environment, or one user, from a backup" (issue 209) puts one back. Both are operator commands — `pnpm backup:export` and `pnpm backup:restore` — and neither is reachable from the app. D1 Time Travel still covers the register in place, and only the register; see "Migrations and rollback" in [deployment.md](deployment.md). *(What is left is scheduling one, and somewhere off this machine to keep it.)*
- **MCP server.**
- **Per-connector rebuild and troubleshooting tools.**

## 8. Documentation and onboarding

- **Generate documentation automatically from the issues.**
- **Context-sensitive documentation.**
- **Intro guidance for new users**, in the style of [Pendo in-app guides](https://www.pendo.io/product/in-app-guides/).

## 9. Testing and quality

- **Test explorer.** Two artifact sketches of what it should look like:
  - https://claude.ai/code/artifact/50d03585-fc91-423f-a9cd-67e24576ed48
  - https://claude.ai/code/artifact/7c68ea2d-81ce-4801-8f42-ec225b17e927

  *(Taken up in [coverage-reporting-options.md](coverage-reporting-options.md) and the working generator in [poc/coverage-explorer](../poc/coverage-explorer/README.md).)*
- **Test explorer must separate the layers:** backend, API, and frontend, with frontend split into Android and web. *(Partly covered: the tree-by-level matrix in [coverage-reporting-options.md](coverage-reporting-options.md) separates the test levels. The Android-versus-web split of the frontend levels is not in there yet.)*
- **Phone-screen tests.** Add tests that make sure rendering and functionality on phone screens (e.g. Android) also work well.
- **Coverage assessed from issues.** Can we use the issues to see whether we have sufficient tests, i.e. use the scope of the existing issues to check that everything is sufficiently covered? *(Adjacent to "when does a node owe its own tests" in [coverage-reporting-options.md](coverage-reporting-options.md), which derives the obligation from the code tree rather than from the issues.)*
- **Product tree vs code tree.** Add a guideline about whether tests should follow the *product* tree rather than the *code* tree. The problem with the code tree is that coverage over it cannot tell you whether you have enough tests. Open questions:
  - Should the code tree follow the product tree, or only the test code?
  - Using the product tree also makes tests easier to keep through a major refactoring, because you can see more easily whether a test is still there.
  - Will we structure the markdown files by concept (action, dashboard, ...)?

## 10. Development process

- **A skill to create issues.** *(Implemented: [github-issue](../.claude/skills/github-issue/SKILL.md) files an already-scoped piece of work; the sharpening and sizing live in [scoping](../.claude/skills/scoping/SKILL.md) so they trigger on any new work starting.)*
- **Issues must be small enough** that you can control what is tested. *(Enforced by `scoping` as a vertical-slice size gate.)*
- **Issues cannot be the long-term link.** The durable link is to *features*, because features change while issues are closed and left behind. *(The statement list says explicitly that it stops being the reference once building starts.)*
- **Migrate the glossary/ADR layout?** mattpocock-skills' `domain-modeling` (`CONTEXT.md` + `docs/adr/`) came up while building the issue-creation skill. The functional definition's glossary maps closely onto `CONTEXT.md` — close to a rename. The architecture's decisions are a different matter: they live as prose sections inside one narrative document, so splitting them into `docs/adr/NNNN-slug.md` files is a real decomposition. Deferred, and worth deciding on its own footing.

## 11. Sources to connect

- **Incoming invoices.** Show the invoices coming in to me.
- **Read, respond and flag from the Inbox.** *(Design decided, not built, and meaningless until a connector exists.)* Once an Item comes from a real source, its content should be readable in the app, and where the source supports it, reactable or repliable to from here — otherwise a deep link takes you to it. Flagging an Item for follow-up would make it a tracked follow-up on the dashboards, exactly as if it had been flagged at the source.
- **Connections, configured per Workspace.** *(Design decided, not built: the connector registry is empty, for every source including Gmail, Slack and Notion.)* Each Workspace declares which accounts it pulls from (*Work* uses work Gmail + company Slack + work Notion; *Personal* uses personal Gmail), which is both the privacy boundary and the source filter. **v1:** Gmail, Slack, Notion — only explicitly marked items at first, widening to the full stream later. **Later:** Linear and Google Calendar, then Chrome bookmarks/downloads and YouTube saved videos. Each connector authenticates via OAuth, pulls new items on a schedule or push, normalizes them into the Item model, and — where two-way sync is enabled — pushes status changes back. Feasibility reference: [integration-options.html](integration-options.html) (as of Aug 2026) rates 15 candidate sources: nine integrate cleanly through official APIs or open protocols (Gmail, Telenet IMAP, the three Slack flavors, Microsoft Teams, Google Tasks, Google Calendar, Billit), three are partial (Signal via signal-cli, Notion mentions via polling, with Notion action items the clean exception), and three have no official read path (personal WhatsApp, LinkedIn InMail and connection requests, where the only workarounds violate the platforms' terms). Reverify the restricted platforms before committing to a build.

## 12. Associations

- **People, Project and Topic/Area associations.** *(Design decided, not built: the schema exists — `associationSchema` in `packages/shared/src/domain/item.ts` — but there is no view yet that adds, shows or filters by one.)* An Item carries any number of Associations, many-to-many, so one message can appear in a *Project Falcon* view and an *Anna* view without being duplicated or moved. A Panel able to query by association is the missing half.
- **Associate it, from the Inbox.** *(Design decided, not built, and depends on the view above existing.)* Every Item's own menu would carry a way to tag it to a Person, Project and/or Topic, which is what puts it in the right panels.

## 13. Focus horizons

- **Focus horizons.** *(Design decided, not built: `focus_horizon` is a dead column, written nowhere.)* Any Item can be flagged with a Focus horizon — Today, This Week, This Month, This Quarter — date-anchored so an Item flagged Today renders as Overdue the next day if not completed, and the same escalation applies to Week/Month/Quarter as each period ends. Set from any Panel ("Add to This Week's Focus") or from the Item's detail view; a Focus Panel would show what is committed to per horizon. An end-of-period review would surface a roll-up if too many Focus items are still open.

## 14. AI layer

The one part of this that is built is cleaning up a captured note into a title and description, with alternate Readings where the note genuinely supports more than one — see `docs/product/items.md`. Everything below is designed, not built:

- **Action extraction (the next-action label).** Read the full thread, not the last message, and distil the concrete thing to do into one line, shown on a Panel's action cards (`docs/product/dashboards.md`) and always editable.
- **Per-item / per-thread summary** so long or technical messages can be triaged without reading the whole thread.
- **Suggested associations.** On arrival, propose the likely Project/Person/Topic tags to confirm or override — depends on the Associations view above (§12) existing first.
- **Dashboard highlights digest** — "here is what needs follow-up today" across all sources, optionally as a daily push.
- **Reading-digest topic extraction.** Detect that an email is content rather than correspondence, split it into its individual stories, and rank those against topics of interest. Finer-grained than a per-item summary, since one newsletter can hold ten unrelated stories of which one matters. Feeds the Reading digest panel, itself not built (see "Sources to connect" and the panel-types note in `docs/product/dashboards.md`).

## 15. Offline writes and reconciliation

*(Design decided, not built: instant rendering from a local cache is built — see `docs/product/offline.md` — but a write made offline is not queued, and there is nothing yet to reconcile against.)*

- **Queued offline writes.** Triage actions taken offline would be captured locally and queued, syncing to the backend — and to source apps where two-way sync applies — on reconnect. Recommended conflict rule: last-write-wins per field, with source apps read-only unless two-way sync is explicitly enabled.
- **Staleness and reconciliation, once a source exists.** The source app stays the source of truth for everything it owns. Every Item's fields split in two: **source-owned facts** (whether the object still exists, its content, its state at the source — every re-sync overwrites the cache unconditionally) and **app-owned facts** (associations, focus flags, whether it has been finished with, edited next-action labels, panel placement, manual sort order — reconciliation never touches these). Convergence would layer, cheapest first: push where the source offers it (Slack events, Gmail push, near-real time at almost no cost); periodic delta re-sync for sources without reliable push (Notion is polling-based); opportunistic re-verification on returning from a click-through, the same moment the round-trip prompt (see "action cards" in `docs/product/dashboards.md`) already watches for. A source change should have the same effect as processing the item here, so completing something in Notion would count as done.
- **Tombstones instead of silent deletes.** *(Schema exists, unused: `sourceResolvedAt` on the items table, set to null on creation and never written elsewhere.)* An object that disappears or completes at the source would mark the Item *resolved at source* rather than vanishing. Whether that surfaces for confirmation is open decision #18.
- **Freshness shown on screen.** Each Item would carry a *last-verified* timestamp, and a Panel could show how fresh its data is ("synced 2 min ago") so a stale view is at least an honest one.
