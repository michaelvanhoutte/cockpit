/**
 * What an account nobody has used arrives with to explain Cockpit ("Guide a new
 * account through Cockpit from a Getting started panel, instead of asking it to
 * name a workspace", issue 767): a Panel of steps, each an ordinary Task, and
 * one Task in the Inbox. `gettingStarted` in changes.ts turns this into rows,
 * and nothing else reads it.
 *
 * **Data, not schema**, for the reason guest-seed-data.ts gives: what a
 * reviewer checks here is the words, so the words are what is on the page.
 *
 * **Every description is Markdown, stored as written.** A Task's description is
 * drawn as Markdown, so the bold, the lists and the code span reach the person
 * as formatting.
 *
 * **Edited here reaches only accounts made afterwards.** An account's steps are
 * its own Tasks from the moment they are written, and this change never runs
 * twice, so rewording a step changes nothing anybody already holds.
 */

/** One Task of the guide: its title, and its description as Markdown. */
export interface GuideTask {
  readonly title: string;
  readonly description: string;
}

/** The Panel the steps are filed on, placed before *Panel 1*. */
export const GETTING_STARTED_PANEL_NAME = 'Getting started';

/** The one Task in the Inbox, saying what the Inbox is for. */
export const INBOX_TASK: GuideTask = {
  title: 'This is your Inbox — start here',
  description: `This is an item, and it is in your **Inbox**. Everything lands here first: what you capture, the Gmail conversations you label, the Teams messages you save. The Inbox holds what you have not dealt with yet, so the aim is to keep it short.

Deal with each item in one of three ways:

- **File it** onto a panel, where it waits beside things like it. Drag it there, or choose **Move to…** from its own menu (the three dots).
- **Mark it done** from its menu (**Status ▸ Done**), if it was already handled.
- **Dismiss it** from its menu, if it never needed doing.

Try it now: work down **Getting started**, the panel beside the Inbox, then mark this item done from its menu (**Status ▸ Done**).`,
};

/** The steps, in the order the Panel holds them. */
export const GETTING_STARTED_TASKS: readonly GuideTask[] = [
  {
    title: 'Welcome to Cockpit — start here',
    description: `Cockpit is for the things you cannot handle right away and do not want to forget to handle later. Everything like that goes in one place, and you decide where each one belongs.

This panel is your way in. Work down it from the top: each row is one thing to try, and opening it (double-click) says how.

Each row is an ordinary task, like the ones you will make yourself. When you have done one, point at its row and press the **✓** beside its dots to tick it off — try it on this one now.`,
  },
  {
    title: 'See how Cockpit is organised',
    description: `Everything you have to deal with arrives in the **Inbox**, on the left — what you capture, and what comes in from Gmail and Teams. From there you file it into the place it belongs:
- A **workspace** is one part of your life — Work, Personal. Each has its own Inbox and its own connected Gmail and Teams, and nothing crosses between them. They are the tabs at the very top.
- A **dashboard** is a view inside a workspace — one per project or per customer, say. They are the tabs in the coloured band.
- A **panel** is a box on a dashboard. This list is one. There are three kinds, chosen when you add one with **+ Panel**:
  - **Items** holds what you file into it — your one-on-ones, what is waiting on somebody else.
  - **Text** is a box you write in — notes, an agenda.
  - **Filter** gathers everything matching a rule, such as all that is due this week, without you filing it.

So: Work › Project Falcon › Waiting on others. You start with one of each, and add more only once you feel the need.`,
  },
  {
    title: 'Capture something',
    description: `Everything you have to deal with starts in the **Inbox**, on the left. Type a to-do or a thought into the box at the top of it and press Enter.

On a phone, Cockpit opens on Capture. Claude can capture for you too, once you connect it.`,
  },
  {
    title: 'File it onto a panel',
    description: `The Inbox holds what you have not dealt with yet. Dealing with something means filing it: drag it from the Inbox onto **Panel 1**, or choose **Move to…** from its own menu (the three dots).

A **panel** is a box for one kind of thing — your one-on-ones, what is waiting on somebody else, what the next board meeting needs. Add more with **+ Panel**.`,
  },
  {
    title: 'Connect your Gmail',
    description: `Cockpit is for the things you cannot handle right away and do not want to forget to handle later — and many of them start as a mail. Connect Gmail, and the mails you pick land in your Inbox beside everything else you still have to do. Finish one here and it is tidied away in Gmail too.

Open **Settings › Connections** from the circle at the top right, and connect Gmail. Then label a conversation \`Cockpit\` in Gmail, by hand or with a Gmail filter, and it arrives in your Inbox within a few minutes. Mark it done here and the label comes off there.`,
  },
  {
    title: 'Connect your Teams',
    description: `Cockpit is for the things you cannot handle right away and do not want to forget to handle later — and in Teams those are a question in a chat or a request in a channel, gone from view once the conversation moves on. Connect Teams, and the messages you save land in your Inbox beside everything else you still have to do.

Open **Settings › Connections** from the circle at the top right, and connect Microsoft Teams. Then save a message in Teams and it arrives in your Inbox.`,
  },
  {
    title: 'Create a Cockpit Agent',
    description: `An **agent** hands an item to Claude to work on, with instructions you write once and reuse. For example:
- **Draft a reply** — write an answer to this mail for me to check.
- **Research** — find out what I need to know about this and summarise it.
- **Plan it** — break this into the steps it takes.
- **Fix it** — make the change this bug report describes, in our code.
- **Scope it** — work out what this feature idea would take, before anybody builds it.
- **Build it** — take this feature from idea to working code: scope it, design it, build it.
- **Log a bug** — file this as a bug report, with what goes wrong and how to see it happen.

Agents live in the dock at the bottom of the screen. Make one with **+ New agent**, connect Claude Code to this workspace under **Settings › Agent settings**, then drag the agent onto any item to start it. The item shows how it is getting on.`,
  },
  {
    title: 'Name your workspace',
    description: `A **workspace** is one part of your life — Work, Personal. Each has its own Inbox and its own connected Gmail and Teams, and nothing crosses between them.

This one is called *Workspace 1*. Rename it from its tab: right-click it, or press the **…** at the right of the header and choose **Edit…**. Make another with the **+** beside the tabs.`,
  },
  {
    title: 'Delete this panel when you are done',
    description: `Once these are ticked off, delete **Getting started** from its own menu (the dots on its header). Nothing else goes with it.`,
  },
];
