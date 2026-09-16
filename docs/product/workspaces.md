# Workspaces

## 4. Core concepts and terminology

Everything is built from a **container hierarchy** and an **item model**.

### 4.1 Container hierarchy (resolves "dashboard vs workspace")

**Workspace** — everything you want in front of you while you work in one context, and the privacy boundary. It controls **which source accounts are connected and visible**, so private email is invisible while in *Work*: scoping rather than filtering after the fact.

**What decides between a Workspace and a Dashboard is whether the whole context changes**, and the pair of cases is the definition: a contractor working for two customers wants a Workspace each — different accounts, different mail, nothing shared — while somebody at one company serving two customers wants one Workspace and a Dashboard per customer, because the context is the same and only the view of it changes. The obvious advice, *one for work, one for personal, one per customer*, gives the second of those the wrong answer, which is why the app says this in the question that makes one rather than leaving it to be inferred.

Each Workspace has a **color identity of four colors**: a saturated tint, and three surfaces stepping from deepest to lightest — the header bar, the strip the Dashboard tabs sit on, and the sheet behind the panels. The two chrome surfaces are near-black in the Workspace's own hue and the sheet is near-white in it, so chrome and content are different kinds of surface rather than three neighbouring shades of one. The tab you are on is filled with the surface below it and joins onto it, so the container hierarchy reads as depth rather than as two rows of pills on one fill, and the tint marks its top edge. Switching Workspace repaints all four. Nothing else moves — what is drawn on the chrome is one fixed light set, and rows, controls and text on the sheet keep the fixed neutral and accent palette — which is what lets the colors be chosen freely. They are picked as a set from a fixed palette, on the form the Workspace's own tab opens (open decision #13). A Workspace wearing surfaces the palette no longer has, or a tint it never had, is drawn in the theme its tint belongs to rather than in what it stores: the light text on the chrome cannot be read on a surface from an older palette.

**A Workspace is made from the `+` at the end of the tabs**, which opens the question a Dashboard and a Panel are named in and says what a Workspace is. That control was in the header's menu, two presses in, on the grounds that you make three or four Workspaces in a lifetime — which held until the question had something to say, and left the explanation behind a door nobody new would open. **Everything else is on the tab itself** ("Change a workspace or a dashboard on the tab it is", issue 267): its menu holds *Edit…*, *Move left*, *Move right* and *Delete*, and there is one entry for changing a Workspace rather than a *Rename* beside it, the form being what renames. This replaced a window opened from the header's menu, where each Workspace was a row — two presses and a list to search away from a strip you are looking at. **The tab opens its own menu three ways, one per input**: a right-click, a press on the tab you are already on (that press has no other job, and it is what a finger has), and the keyboard's menu key. **The name and colour are changed together, on a form over the page**; nothing is sent until *Save*, so a colour is chosen and looked at rather than applied on the press, and *Cancel*, *Escape* and a press outside all discard both halves. A name is required, stored trimmed, one line of at most 60 characters, and unique among live Workspaces whatever the capitalization. **Deleting a Workspace keeps everything that was in it**: its Items stay filed against it, because the router learns from the whole history of where things were filed (routing that learns from past decisions, "What the model reads: the whole history, no retrieval"). The name becomes available again. The last Workspace can be deleted, and the app then opens on the screen that makes one.

**The Workspaces are in the order you put them in, left to right** ("Reorder workspaces", issue 31). A new Workspace goes last, after every Workspace the account has ever had; deleting one closes the gap. Two ways to move one, neither the lesser: the tab is dragged along the strip, and **Move left** / **Move right** in its menu take it one step. The drag is the pointer's alone — it is absent on a touchscreen and unreachable from a keyboard — so the menu is the way those two have, and at either end the entry stays, unavailable, saying *It is already the first*, rather than disappearing. **The tabs move as the drag does**, so the strip under the hand is the order dropping would keep. A move shows itself before the server agrees, so a second move can follow a first and a dropped tab does not snap back for a round trip. If it is refused, because a Workspace was made or deleted in another tab, the strip goes back — which is all it does today: the window this replaced had a line under the row to say why, and a strip of tabs has nowhere to put one yet.

**Ask up front only what has to be decided up front, and teach the rest at first use.** An account arrives holding one Workspace called *Workspace 1*, one Dashboard and one Panel, and opens on a single question: what that Workspace is. A Workspace is the one thing somebody can answer on the day they arrive — it is the privacy boundary, there are few of them, and *work*, *personal* or a customer's name is already true. A Dashboard and a Panel are not: nobody knows when they want a second Dashboard until they have used the first for a while, so asking at sign-in would demand a decision in the one moment it cannot be made. The question **renames** rather than makes, so *Skip* and an empty box are the same answer as any other and leave an app that works.

**What the question is asked of is the account's own rows, and having been through it is the browser's.** One Workspace still wearing the name it arrived with is what "nobody has started on this" looks like — nothing is stored to know it, so an account restored from a backup is exactly as far along as its rows say — and the browser remembering the question was asked is what stops it being asked twice. A browser that refuses storage asks again, and naming the Workspace is what ends it. Only the root address opens the question; a link to a Dashboard is never diverted into it.

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

## 9. Integrations and connections

**Connections are configured per Workspace.** Each Workspace declares which accounts it pulls from (*Work* uses work Gmail + company Slack + work Notion; *Personal* uses personal Gmail). This is both the privacy boundary and the source filter.

- **v1:** Gmail, Slack, Notion. In **iteration 1** these pull only explicitly marked items; in **iteration 2** they widen to the full stream.
- **Phase 2:** Linear, Google Calendar. **Phase 3:** Chrome bookmarks and downloads, YouTube saved videos.

**Feasibility reference.** [integration-options.html](integration-options.html) (as of Aug 2026) rates 15 candidate sources: nine integrate cleanly through official APIs or open protocols (Gmail, Telenet IMAP, the three Slack flavors, Microsoft Teams, Google Tasks, Google Calendar, Billit), three are partial (Signal via signal-cli, Notion mentions via polling, with Notion action items the clean exception), and three have no official read path (personal WhatsApp, LinkedIn InMail and connection requests, where the only workarounds violate the platforms' terms). Reverify the restricted platforms before committing to a build.

Each connector authenticates (OAuth), pulls new items on a schedule or push, normalizes them into the Item model, and — where two-way sync is enabled — pushes status changes back.
