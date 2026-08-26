# Ideas Backlog

Raw feature ideas for Cockpit, captured as voice/WhatsApp notes between 17 and 25 August 2026 and grouped here by theme. This is a **capture list, not a plan**: nothing here is decided, sized, or scheduled, and no issues have been created for any of it. Items that contradict each other or that overlap with the [functional definition](functional-definition.md) are kept as written, because the wording is the record of what was actually wanted.

Where an idea affects an existing decision, the relevant section is referenced. Terminology follows the functional definition: Workspace → Page → Panel, Item, Association. A few of these notes have since been taken up in their own documents ([routing-learning.md](routing-learning.md), [coverage-reporting-options.md](coverage-reporting-options.md)); those are marked where they appear, and the note is kept so the origin of the requirement stays visible.

---

## 1. Panels and dashboard layout

- **Per-panel connection configuration.** Every Panel gets a "..." configuration option in which you can enable/disable which connections that Panel is allowed to use.
- **Per-panel plain-English description box.** Every Panel gets a multiline text box in which you type, in plain text, what information you want rendered there. Example: *"all saved actions related to customers, categorized per customer."* First step: add the box to the UI without wiring it up to anything yet. (Relates to the plain-English rule configuration in §6.2 of the functional definition.)
- **Define the Gmail actions Panel.** Work out the concrete definition of the Panel that shows Gmail actions; it is the first consumer of the two configuration options above.
- **Fixed-size panels are probably not good enough.** Panels may have to resize. Related open question: how do Panel positions change when the Inbox opens or closes?
- **Auto-resize on/off.** Give an option to auto-resize panels or not.
- **Highlight the destination.** When you click an Item in the Inbox, highlight the Panel or Panels that Item would be moved into.
- **Table view.** Support a table view next to the Panel view.
- **Zoom.** Support zooming in the Panel view.
- **Configurable item types.** Add configurable types (e.g. *action* and *note*) that can be created and moved in a Panel, and render each type differently.

## 2. Capture and the task creator

- **Remember the last project used**, and remember colour suggestions in a particular way.
- **Task vs thought.** When creating an entry, let me choose between a *task* (something actionable) and a *thought* (not directly actionable).
- **Guidance alongside a thought.** Let me set guidance next to a thought, e.g. *"the next few thoughts are likely about project X."*
- **Three cleaned-up phrasings.** Make three suggestions of cleaned-up text and let the LLM learn from my selections how I want the titles of my actions and notes phrased.
- **Offer multiple interpretations.** When converting a short note into a longer, clearer message and there are several plausible readings, suggest the alternative meanings so I can pick the right one.
- **Learn from triage.** Let the assignment skill learn from the tasks I move out of the Inbox. *(Now specified in [routing-learning.md](routing-learning.md), which treats the correction I make when moving an item out of the Inbox as the learning signal.)*
- **Training window.** Use the last 100 notes for training, weighting the last 25 higher, and include tasks created in the UI through the chat button. *(Partly superseded: [routing-learning.md](routing-learning.md) §8 reads the whole filing history rather than a fixed recency window. Kept as the competing proposal in case the whole-history approach hits a cost or context ceiling.)*
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

## 4. Chat

- **Chat UI** to ask about the priorities of the day and to post further notes and actions. (Its captures feed the training set in §2.)

## 5. Item content

- **Rich text** in the description of an action/note.
- **Attachments** in the description of an action/note.

## 6. Search, archive and organisation

- **Search.**
- **Archive management:** the ability to archive items and to browse the archive.
- **Move items between Workspaces.** *(Captured as "move issues between workspaces"; needs clarification whether this means Cockpit Items across Workspaces or dev issues across issue-tracker workspaces.)*

## 7. Platform, users and operations

- **Multiple users, staged.** Start without authentication: the logon page simply shows a list of users to choose from and you log on by clicking a name, no password at all. Add OAuth and password support afterwards.
- **Multi-tenancy.**
- **Audit trail.**
- **Backup.**
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

- **A skill to create issues.**
- **Issues must be small enough** that you can control what is tested.
- **Issues cannot be the long-term link.** The durable link has to be to *features*, because features change while issues are closed and left behind.
