# Workspaces

Everything is built from a **container hierarchy**: **Workspace → Dashboard → Panel**.

**Workspace** — everything you want in front of you while you work in one context, and the privacy boundary. It controls **which source accounts are connected and visible**, so private email is invisible while in *Work*: scoping rather than filtering after the fact.

**What decides between a Workspace and a Dashboard is whether the whole context changes**, and the pair of cases is the definition: a contractor working for two customers wants a Workspace each — different accounts, different mail, nothing shared — while somebody at one company serving two customers wants one Workspace and a Dashboard per customer, because the context is the same and only the view of it changes. The obvious advice, *one for work, one for personal, one per customer*, gives the second of those the wrong answer, which is why the app says this in the question that makes one rather than leaving it to be inferred.

Each Workspace has a **color identity of four colors**: a saturated tint, and three surfaces stepping from deepest to lightest — the header bar, the strip the Dashboard tabs sit on, and the sheet behind the panels (the palette itself is in `docs/design-system.md`). The two chrome surfaces are near-black in the Workspace's own hue and the sheet is near-white in it, so chrome and content are different kinds of surface rather than three neighbouring shades of one. The tab you are on is filled with the surface below it and joins onto it, so the container hierarchy reads as depth rather than as two rows of pills on one fill, and the tint marks its top edge. Switching Workspace repaints all four. Nothing else moves — what is drawn on the chrome is one fixed light set, and rows, controls and text on the sheet keep the fixed neutral and accent palette — which is what lets the colors be chosen freely. They are picked as a set from a fixed palette, on the form the Workspace's own tab opens (open decision #13). A Workspace wearing surfaces the palette no longer has, or a tint it never had, is drawn in the theme its tint belongs to rather than in what it stores: the light text on the chrome cannot be read on a surface from an older palette.

**A Workspace is made from the `+` at the end of the tabs**, which opens the question a Dashboard and a Panel are named in and says what a Workspace is. **Everything else is on the tab itself**: its menu holds *Edit…*, *Move left*, *Move right* and *Delete*, and there is one entry for changing a Workspace rather than a *Rename* beside it, the form being what renames. **The tab opens its own menu three ways, one per input**: a right-click, a press on the tab you are already on (that press has no other job, and it is what a finger has), and the keyboard's menu key. **The name and colour are changed together, on a form over the page**; nothing is sent until *Save*, so a colour is chosen and looked at rather than applied on the press, and *Cancel*, *Escape* and a press outside all discard both halves. A name is required, stored trimmed, one line of at most 60 characters, and unique among live Workspaces whatever the capitalization. **Deleting a Workspace keeps everything that was in it**: its Items stay filed against it, because the router learns from the whole history of where things were filed (see [routing-learning.md](routing-learning.md)). The name becomes available again. The last Workspace can be deleted, and the app then opens on the screen that makes one.

**The Workspaces are in the order you put them in, left to right.** A new Workspace goes last, after every Workspace the account has ever had; deleting one closes the gap. Two ways to move one, neither the lesser: the tab is dragged along the strip, and **Move left** / **Move right** in its menu take it one step. The drag is the pointer's alone — it is absent on a touchscreen and unreachable from a keyboard — so the menu is the way those two have, and at either end the entry stays, unavailable, saying *It is already the first*, rather than disappearing. **The tabs move as the drag does**, so the strip under the hand is the order dropping would keep. A move shows itself before the server agrees, so a second move can follow a first and a dropped tab does not snap back for a round trip. If it is refused, because a Workspace was made or deleted in another tab, the strip goes back.

**Ask up front only what has to be decided up front, and teach the rest at first use.** An account arrives holding one Workspace called *Workspace 1*, one Dashboard and one Panel, and opens on a single question: what that Workspace is. A Workspace is the one thing somebody can answer on the day they arrive — it is the privacy boundary, there are few of them, and *work*, *personal* or a customer's name is already true. A Dashboard and a Panel are not: nobody knows when they want a second Dashboard until they have used the first for a while, so asking at sign-in would demand a decision in the one moment it cannot be made. The question **renames** rather than makes, so *Skip* and an empty box are the same answer as any other and leave an app that works.

**What the question is asked of is the account's own rows, and having been through it is the browser's.** One Workspace still wearing the name it arrived with is what "nobody has started on this" looks like — nothing is stored to know it, so an account restored from a backup is exactly as far along as its rows say — and the browser remembering the question was asked is what stops it being asked twice. A browser that refuses storage asks again, and naming the Workspace is what ends it. Only the root address opens the question; a link to a Dashboard is never diverted into it.

The full path to any box:

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

Connecting a source to a Workspace is designed, not built — no connector exists yet, for Gmail, Slack, Notion or anything else. See "Sources to connect" in `docs/ideas.md`.
