# Routing that learns from past decisions (v0.1)

*Owner: Michael. Status: draft for discussion. Relates to the functional definition (triage flow, panel rules, AI layer, the auto-tagging open decision) and the architecture document (read model, capture outbox, background jobs, AI layer, task-creator merge).*

## 1. Purpose

When a quickly captured note arrives, the system should propose where it belongs — which workspace, project, person or panel — and those proposals must improve over time by learning from where I actually file things, including the corrections I make when moving an item out of the inbox.

## 2. The problem

The naive designs both fail:

- **Classify at capture time.** Breaks the two-second capture budget, breaks offline capture entirely, and classifies with the least knowledge the system will ever have.
- **Classify at triage time, synchronously.** The learning signal — how I filed the earlier notes of a batch — only exists mid-session, so later notes would classify while I wait. A model call takes one to three seconds; I triage at about two seconds per card.

The trap in both is assuming a classification is computed once and then fixed. It is a derived value whose inputs keep changing, and the answer to changing inputs is to recompute, not to postpone.

## 3. Design principle: model calls are free, waiting is forbidden

Model calls at personal volume cost cents per day, so the goal is not to minimise them: it is that **no interaction ever blocks on one**.

| When it fires | What it does | Who is looking at the screen |
|---|---|---|
| A note syncs in | proposes a routing, reading the bounded decision history | nobody |
| The inbox is opened *(not built - a settle fires the equivalent instead, "The decision moments")* | refreshes proposals for everything not yet settled | me, but it runs behind the instant paint |
| ~~Nightly~~ *(removed — the summary it rewrote was read back by nothing, "Drop the nightly filing summary, keep the sentence you wrote", issue 392)* | rewrote the plain-English summary of my filing patterns | nobody |
| I press "re-suggest" on one item | reclassifies that item on demand | me, by explicit request, spinner accepted |

The last row is the one deliberate exception, and it exists so a stale proposal is never stuck — which is what makes the rest safe to run asynchronously.

## 4. Concepts

**Item.** A captured note once it exists in Cockpit.

**Routing.** The subset of an Item's associations that decide where its card shows up: workspace, project, person, topic, panel.

**Proposed vs settled.** *Proposed*: the system put it there and I have not looked. *Settled*: I decided it, by accepting the proposal or choosing something else. This distinction carries the whole design.

**Decision history.** An append-only record of every settled routing — the note text, what was proposed, what I chose, and how. It grows by one entry every time I settle something, and it is the only place learning lives: no training step, no separate feedback action.

## 5. The rule

> **A proposed routing may be replaced by the system at any time, without asking. A settled routing may only ever be changed by me.**

Consequences:

- "When should the system classify?" stops being hard: as often as it usefully can, because a proposal commits nothing.
- Background recomputation can never destroy a human decision, so recomputation and triage run concurrently without coordination.
- Proposals do not populate panels. A card appears in a Project or Person panel only once its routing is settled — the Inbox is the exception by definition, being the panel of items still to process — which answers the functional definition's auto-tagging decision as suggest-and-confirm; flipping to auto-apply later is a default filter change, not an architectural one.
- This adds a further group to the schema's column-ownership split (architecture, "Schema conventions"), alongside source-owned, app-owned and write-once: system-proposed values, overwritable by background jobs until a human touches them, never after.

## 6. The decision moments

| Moment | What is decided | By what | Binding? | Am I waiting? |
|---|---|---|---|---|
| 1. I capture a note | nothing | | | no |
| 2. The note syncs | a proposed routing | model, background job | no | no |
| 3. I open the inbox *(not built - see below)* | proposals refreshed for all unsettled items | model, background job | no | no |
| 4. I triage an item | the routing settles; one history entry appended | **me** | **yes, permanently** | no |
| ~~5. Nightly~~ *(removed, issue 392)* | plain-English summary of my patterns rewritten | model | routes nothing | no |

**Moment 1** stores the note locally and nothing else, because there may be no connectivity and the note must be safe within the capture budget. This is the existing capture outbox, unchanged.

**Moment 2** is the first classification: the model reads the note, the panel definitions (already plain-English sentences) and the decision history, through the existing queue-based enrichment path.

**Moment 3** is what makes learning land. Between triage sessions lie hours or days, so proposals from moment 2 may predate corrections made since; on inbox open, everything unsettled is re-proposed against the current history. **Shipped instead: the same re-proposal fired by moment 4 itself** ("Re-propose the rest of the inbox the moment you file one", issue 300) — a settle already carries the history moment 3 would open the inbox to re-read, so it fires the refresh directly rather than waiting for the next open. The inbox-open trigger this row describes is not built.

**Moment 4** is the only binding moment and the only source of learning. Accepting and overriding both settle the routing and both append to the history, and an override is the stronger signal because it records the rejected answer alongside the correct one.

**Moment 5 is gone, and so is the sentence I wrote.** ("Drop the nightly filing summary, keep the sentence you wrote", issue 392). It was built to keep the model's input bounded and to make what the system learned visible and editable; what shipped was a paragraph rewritten nightly, shown read-only, and fed into nothing, beside a correction that was already the highest-ranked input in the prompt. The correction sentence outlived it for a while and is gone too: Cockpit learns purely from what you do, with nothing you write by hand. Having Cockpit account for itself on demand rather than nightly is `text-learning.md`'s "What Cockpit says about itself".

## 7. Moment 3 in slow motion

**Not built** ("The decision moments"): the inbox-open trigger below never shipped, and moment 4 fires the same kind of refresh instead. Kept as the design this section's own positional guarantee (step 3) still names an intention for, not a description of what runs today.

1. I open the inbox. It paints **instantly from the persisted local snapshot**, which already carries the moment-2 proposals. Nothing is requested before paint.
2. At the same instant the server begins refreshing proposals for unsettled items, taking one to two seconds in total.
3. Results stream back over the existing push channel and update proposal chips **below my current position**, never at or above it, and never in the same frame as a layout reflow.
4. Meanwhile I am already triaging the first card.

The inbox never waits for the refresh and the refresh never waits for the inbox: they start together, and since I read at seconds per card the refresh wins the race unnoticed. Worst case the first card or two show the moment-2 proposal, produced by the same model reading a slightly older history.

## 8. What the model reads: bounded, no retrieval

**Decision: there is no search or retrieval step.** Recorded because the alternative looks more sophisticated and is worse:

- Retrieval exists to cope with corpora too large to show a model. It is a lossy compromise, never an improvement: it can only discard information before the model sees it.
- A history entry is a short note plus a destination, roughly 25 tokens — small enough that a flat cap costs nothing worth optimising around.
- Reading everything relevant is strictly better at the hard cases: notes sharing meaning but no words ("Part 11 audit trail" versus "validation protocol, who signs off"), panels defined by something other than topic ("urgent", "do at home"), and Dutch or mixed notes. Every similarity measure struggles with at least one; a model reading the panel definitions and the history handles all three.

**Bounded two ways, not by a date window.** The model reads the most recent 50 settled decisions for the workspace whose chosen panel still exists ("Cap the routing prompt to the last 50 decisions on panels that still exist, and drop the correction override", issue 450): a flat volume cap as a backstop, and relevance tied to whether the panel itself still exists rather than to how long ago the decision was made. This is what resolves open decision 4 below — a project you have stopped working on stops being suggested once you delete its panel, without a clock and without the empty-window edge case a date cutoff would have had. The workspace's own correction sentence is not read into this prompt, and nothing writes it any more ("Remove the two learning settings screens, and the commands that write to them", issue 452); its table is dropped by "Drop the workspace_routing_summary table" (issue 401).

The scaling ladder, if 50 stops being enough: **raise the constant** (a retune, not a migration, since it names no schema) → **add retrieval**, not reached yet.

## 9. Part 2 (optional, measurement-gated): in-session carry-over

Part 1 is complete and shippable on its own; it closes the cross-session loop. One gap remains.

**The gap.** Within one session I might correct item 1 and reach item 5 eight seconds later, and item 5's proposal was refreshed before that correction. No model call fits: the budget is under a second, inside a picker, possibly offline. This is the only place in the design where a different mechanism is justified.

**The mechanism.** When I file an item into a panel, the client looks at the unsettled notes below it, finds those that textually resemble the one just filed, and offers them the same destination inside the picker already open: "also move: [note], included, one keystroke to exclude". Confirming files the group as **one command**, so one undo reverses all of it. Resemblance is computed locally (embeddings shipped in the snapshot, a dot-product scan, about a millisecond over a few thousand notes), so it works offline and is ready before I have finished choosing.

One non-obvious rule: when the filing was an *override*, the features behind the rejected proposal must be excluded from the scoring. If the system proposed "Laurens" and I chose "Compliance questions", then "Laurens" was demonstrably not the deciding signal.

**Why this stays separate from Part 1:** it rests on an assumption Part 1 does not — that textual resemblance predicts co-destination — which is measurable rather than arguable; it structurally cannot learn non-topical panels, which Part 1's model can via the panel definitions; and its failure is asymmetric and tunable, too cautious costing nothing and too eager costing wrong items on a fast confirm, mitigated by a conservative threshold, group undo and a toast naming what came along.

**Embeddings exist only for this.** Part 1 uses none. Computing and storing them from day one is cheap insurance: it enables the offline measurement below without a backfill, and nothing consumes them until Part 2 exists.

## 10. Measurements gating Part 2

1. **Offline, before building anything.** The task-creator Notion database is a labelled corpus. Embed every note and check whether its nearest textual neighbour shares its category; that percentage is the ceiling on carry-over precision. Roughly 80% or more: worth building. Lower: the question is closed for the cost of an afternoon script. Run it separately for Dutch notes, since small embedding models are English-trained.
2. **Live, after shipping Part 1.** Instrument one event: how often a correction is followed, in the same session, by another item that correction would have re-routed. If it is rare, Part 2 is not worth its complexity regardless of measurement 1.

## 11. Build order

1. **Part 1**: decision history, proposed/settled states on associations, the classification job at moments 2 and 3, the re-suggest action, the settings screen showing the summary. *Shipped, then removed: the summary half ("Drop the nightly filing summary, keep the sentence you wrote", issue 392) and the screen ("Remove the two learning settings screens, and the commands that write to them", issue 452).*
2. **Instrument** the two measurements.
3. **Part 2** (carry-over), only if the numbers justify it.
4. **The summary as prompt input**, only when history size demands it. *Nothing to re-point: the summary was never made an input, which is why it was removed (issue 392).*

## 12. Consequences for the two codebases

**task-creator.** The capture outbox transfers as the architecture's merge plan describes. The client-side refine-before-send path is retired: it is the late-and-synchronous pattern this document rejects and cannot work offline. Manual pickers survive with a changed meaning — a manual choice is a settled value and a history entry, not a hint to the enricher. The Notion destination retires with the stopgap, replacing its category vocabulary with Cockpit's panels and associations.

**cockpit.** Part 1 needs the decision-history table; proposal state (origin, confidence, confirmed-at) on associations; a classification job on the existing enrichment queue; refresh-on-snapshot; the re-suggest command; and the nightly summary job with its settings screen (both since removed). Part 2 adds an embedding per item, the client-side resemblance scan, and a group-filing command with group undo. All of it fits the existing shapes — commands, queue jobs, snapshot plus push invalidation — with no new infrastructure.

## 13. Open decisions

1. ~~Scope of the history: per workspace or global?~~ **Decided: per workspace** ("Learn where notes belong from where you actually file them", issue 299), on this recommendation — it is the privacy boundary and the routing vocabulary genuinely differs between Work and Personal. Cost, accepted: cross-workspace patterns are not learned.
2. **Does the capture UI show proposals at all?** Fire-and-forget versus chips fading in a second after save. *Recommendation: fire-and-forget in v1*, being simpler and identical offline and online; revisit once proposals are demonstrably good.
3. **When does suggest-and-confirm flip to auto-apply?** The design makes the flip a default filter change. *Proposed trigger: a sustained acceptance rate above a chosen threshold*, visible in the instrumentation, rather than a gut call.
4. ~~Weighting of history entries: overrides should outweigh passive accepts, and old decisions should decay.~~ **Decided: decay is tied to whether the decision's panel still exists, not to how long ago it was decided** ("Cap the routing prompt to the last 50 decisions on panels that still exist, and drop the correction override", issue 450, "What the model reads: bounded, no retrieval") — simpler than a date window, with no empty-window edge case, and matching how staleness already works everywhere else: delete what you are done with. Overrides outweighing accepts is unchanged: an override still records the rejected answer alongside the correct one, in the prompt's own text ("What the model reads: bounded, no retrieval").
