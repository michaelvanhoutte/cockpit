# Items

### 4.2 Item + Association model (resolves "one message in two inboxes")

Everything that flows in — email, Slack message, Notion page, later a calendar event or bookmark — normalizes into a single **Item**, storing: source app (or *internal*), source ID, a deep link back, sender/author, timestamp, its three texts, its **Type**, optional priority, optional due date, and whether it has been finished with. Native notes and to-dos created in the app have no source app and open in the app rather than deep-linking out.

**An Item carries three texts, answering three different questions** ("Edit an item's title and description on a form of its own", issue 159). The **captured message** is what arrived, or what you said: written once when the Item is made and never changed by anything afterwards, because it is the record of what was actually captured. The **title** names the Item and the **description** is what you have to say about it; both are yours to edit and neither is required. **The description is formatted text, stored as Markdown** ("Format a description, and edit its source", issue 160): bold looks bold as it is written, and the same description can be worked on as its source. Bold, italic, links and both kinds of list have a button and a keyboard shortcut; a heading, a table, an image, a code block or strikethrough has neither and is kept all the same, because a description pasted out of somewhere else must arrive whole.

**Only two of the three are ever shown.** The captured message is a record, not a name, and it is what the title and description are read back against. It stood in as a label until an Item had two names — the one its row showed and the empty one its form offered under it — which is what **capture writing the title** fixed: what you capture becomes the title, and where it does not fit one line of 200 characters the title takes the first 200 and the whole of it goes into the description, so nothing you typed is only in a text you cannot edit.

**And a moment later Cockpit rewrites both of them, having read the note** ("Clean up a captured note into a clear title and a fuller message", issue 296). Capture is meant to be fast, so what arrives is clipped, abbreviated, half-typed and often a mix of English and Dutch — and two weeks later the row says `part 11 audit trail q for validation protocol, who signs off eod` with none of the context around it left. So the note is read and given a **title** as short as it can be while still naming this note and no other, and a **description** that writes out what was said so it still makes sense in two weeks.

- **It adds nothing the note does not contain.** Abbreviations are expanded, spelling corrected, a clipped sentence finished and a dictated one reordered; a fact, a name, a date, a reason or a next step is never supplied. Where the note refers to something it never states, the description says the note does not say.
- **Both texts are *proposed*, and yours the moment you edit either.** Editing the title or the description takes both over for good, and nothing overwrites either again.
- **The answer is in the language the note was written in**, whichever of the two that is, and a note mixing them stays mixed.
- **Capture never waits for it and never fails because of it.** The Item is written and answered first; the reading follows. Where nothing is set up to read a note, where the reading fails, or where what comes back is not usable, the Item simply keeps the title capture wrote — which is the behaviour that shipped before this, so nothing is worse than it was.
- **Only notes captured after this shipped are read.** Nothing sweeps what is already there, so a title you wrote by hand is out of reach by construction rather than by a rule.

**The same reading may say the note genuinely takes two meanings, and offer both** ("Offer the other readings when a captured note says two things", issue 297). `bel jan` is *call Jan* or *call in January*; picking the wrong one silently is a wrong answer nothing afterwards can spot. Where that is true, Cockpit lists the other **Readings** beside the one it wrote onto the Item — each its own title and description, and a few words saying what that reading takes the note to mean — and choosing one puts its title and description in the two boxes, exactly as typing them in by hand would. **Reporting none is the common case and the right one:** a note that is merely terse has one reading, and only a difference that would change what you do about the note is worth naming a second time. The row carries one quiet mark saying a note reads more than one way; the readings themselves wait for the form, the way the captured message does.

**A note that lands in the description is Markdown, not escaped text**, decided when capture started writing there: somebody who captured a `- ` list meant a list, and the source view and *What was captured* both hold the note exactly as typed for the times they did not. The cost is that a note written over several lines reads as one paragraph, a single line break being a soft break in CommonMark; making capture propose formatting rather than inherit it belongs with the rest of the smarter capture ([ideas.md](ideas.md), "Capture and the task creator").

**A row shows the next action, or the title**, and *Untitled* where an Item has neither — the best label it has, worked out where the row is drawn. Not stored as a text of its own, which would be a summary free to go stale behind the two it summarises. **Where the row is too narrow to draw the whole label, hovering it spells the label out**, and where the row drew all of it, hovering says nothing: a tooltip repeating what you can already read is noise on every row of a list you scan. The cut is in the drawing alone, so a screen reader has had the whole label the entire time; a finger, which cannot hover, opens the Item instead, and the form shows it whole.


Items are **not filed into one folder.** Each carries any number of **Associations**: to one or more **People**, **Projects**, **Topics/Areas** (*Research*, *People to discuss*), a **Workspace** (rarely more than one) and optional **Focus** flags.

Because associations are many-to-many, one message appears in the *Project Falcon* panel **and** the *Anna* panel without being duplicated or moved. A Panel is a query over Items, so the same Item shows up in every Panel whose filter it matches.

**Every Item has a Type** — *Task*, *Note*, or whatever else you name — which is what kind of thing it is, as against where it stands. The set is open and account-wide. Capture offers the types you already have, the three used last first, and opens on the one used last; it does not make one ("Make a type where types are managed, not while capturing", issue 203), and it has **no answer of *none*** — where no chip has been pressed the one used last is already the answer. A front door with nobody to press one waits for the type to be worked out from the note itself (`docs/ideas.md`, "Capture and the task creator") rather than capturing without one; with no types at all, capture says so and refuses.

Types are managed in a window of their own, opened from the header's menu because they belong to the Account and have no tab of their own: made in a box above the list, a row each, renamed and recoloured together on the same form a Workspace's tab opens, deleted through the same dialog as everything else, and put in the order capture offers them in — the Ordering rule, so the grip and the row's own *Move up* and *Move down* are the same move ("Manage the types, and put them in the order you want", issue 156). **A Type's name is typed in one place**, so the same word cannot be spelled two ways: making one used to be capture's alone and is now this window's alone, and a name another Type already has is refused there rather than quietly reused. Making one asks for a name and nothing else — the colour is the first the palette has free, changed afterwards on the row's own form, exactly as a Workspace's is. **Deleting a Type leaves its Items where they are**, holding everything except the label — the same way deleting a Workspace keeps everything filed against it — and gives the name back.

**An Item is either yours to deal with or finished with**, and nothing in between ("An item is either yours to deal with or finished with", issue 154). Being finished with one is a time, so it says *when*; dismissing one is the tombstone that makes it reversible. The eight-value status this replaced — To Process, Task, Waiting, Snoozed, Delegated, Reference — was never asked for, and six of the eight changed a mark on the row and nothing else. What kind of thing an Item is belongs to its **Type**, and a due date is a field. A Kanban board, a to-do list and the inbox are still all Panels over the same Items.

## 7. Focus and Goals (time-horizon priorities)

Any Item can be flagged with a **Focus horizon**: **Today, This Week, This Month, This Quarter**. These are date-anchored, not merely colored, which is the key requirement.

- An Item flagged **Today** is anchored to today's date and renders as **Overdue** the next day if not completed. The same escalation applies to Week/Month/Quarter as each period ends.
- **End-of-period review.** As a month or quarter closes, the app surfaces a roll-up if too many Focus items are still open ("You have 6 open items in this quarter's focus with 3 days left").
- **How you set it.** Select Items in any Panel and choose *"Add to This Week's Focus"*, or set it from the Item's detail view. A **Focus Panel** shows what is committed to per horizon.

### 7.1 Deadline color states

Independently of Focus horizons, an Item can carry a hard **due date**, and cards are color-coded by proximity: neutral while there is time, **orange** once the deadline is reached (due today, or within a set threshold), **red** once passed, in every Panel the item appears in. A "This Week" focus flag anchors to end-of-week while a due date is a specific date, but both feed the same treatment.

## 8. AI layer: executive summaries and highlights

- **Per-item / per-thread summary** so long or technical messages can be triaged without reading the whole thread.
- **Action extraction (the next-action label).** Read the full thread, not the last message, and distil the concrete thing to do into one line (see "action cards" in `docs/product/dashboards.md`). Always editable.
- **Suggested associations.** On arrival, propose the likely Project/Person/Topic tags to confirm or override. This is where most of the day-to-day value is.
- **Dashboard highlights digest** — "here is what needs follow-up today" across all sources, optionally as a daily push.
- **Plain-English panel rules** — turn a free-text description into the structured saved query behind a Panel and render the interpretation back for confirmation (see "What a Panel shows" in `docs/product/dashboards.md`).
- **Reading-digest topic extraction** *(iteration 2)* — detect that an email is content rather than correspondence, split it into its individual stories, and rank those against topics of interest. Finer-grained than a per-item summary, since one newsletter can hold ten unrelated stories of which one matters.

Where the AI runs (cloud versus on-device) interacts with the offline requirement — open decision #6.
