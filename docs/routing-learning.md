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
| A note syncs in | proposes a routing, reading the full decision history | nobody |
| The inbox is opened | refreshes proposals for everything not yet settled | me, but it runs behind the instant paint (§7) |
| Nightly | rewrites the plain-English summary of my filing patterns | nobody |
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
| 3. I open the inbox | proposals refreshed for all unsettled items | model, background job | no | no |
| 4. I triage an item | the routing settles; one history entry appended | **me** | **yes, permanently** | no |
| 5. Nightly | plain-English summary of my patterns rewritten | model | routes nothing | no |

**Moment 1** stores the note locally and nothing else, because there may be no connectivity and the note must be safe within the capture budget. This is the existing capture outbox, unchanged.

**Moment 2** is the first classification: the model reads the note, the panel definitions (already plain-English sentences), the nightly summary and the decision history, through the existing queue-based enrichment path.

**Moment 3** is what makes learning land. Between triage sessions lie hours or days, so proposals from moment 2 may predate corrections made since; on inbox open, everything unsettled is re-proposed against the current history.

**Moment 4** is the only binding moment and the only source of learning. Accepting and overriding both settle the routing and both append to the history, and an override is the stronger signal because it records the rejected answer alongside the correct one.

**Moment 5** keeps the model's input bounded as the history grows, and makes what the system learned *visible and editable*: the summary renders in settings as plain English ("notes about validation, audit trails and sign-off go to Compliance questions, even when they name a person") and I can correct it in a sentence. Same philosophy as plain-English panel rules — no black box, no rule wizard.

## 7. Moment 3 in slow motion

1. I open the inbox. It paints **instantly from the persisted local snapshot**, which already carries the moment-2 proposals. Nothing is requested before paint.
2. At the same instant the server begins refreshing proposals for unsettled items, taking one to two seconds in total.
3. Results stream back over the existing push channel and update proposal chips **below my current position**, never at or above it, and never in the same frame as a layout reflow.
4. Meanwhile I am already triaging the first card.

The inbox never waits for the refresh and the refresh never waits for the inbox: they start together, and since I read at seconds per card the refresh wins the race unnoticed. Worst case the first card or two show the moment-2 proposal, produced by the same model reading a slightly older history.

## 8. What the model reads: the whole history, no retrieval

**Decision: there is no search or retrieval step.** The decision history is text, included in the model's input in full. Recorded because the alternative looks more sophisticated and is worse:

- Retrieval exists to cope with corpora too large to show a model. It is a lossy compromise, never an improvement: it can only discard information before the model sees it.
- The corpus is small. A history entry is a short note plus a destination, roughly 25 tokens, so a year of heavy use is on the order of 50,000 tokens. It is a stable append-only prefix, the ideal shape for prompt caching.
- Reading everything is strictly better at the hard cases: notes sharing meaning but no words ("Part 11 audit trail" versus "validation protocol, who signs off"), panels defined by something other than topic ("urgent", "do at home"), and Dutch or mixed notes. Every similarity measure struggles with at least one; a model reading the panel definitions and the full history handles all three.

The scaling ladder, if the history outgrows the prompt: **full history in the prompt** (now, nothing to build) → **nightly summary plus the most recent decisions** (a semantic compression written by a model that read everything, and inspectable) → **add retrieval**, which may never be reached.

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

1. **Part 1**: decision history, proposed/settled states on associations, the classification job at moments 2 and 3, the re-suggest action, the settings screen showing the summary.
2. **Instrument** the two measurements.
3. **Part 2** (carry-over), only if the numbers justify it.
4. **The summary as prompt input**, only when history size demands it. The summary *screen* ships in step 1.

## 12. Consequences for the two codebases

**task-creator.** The capture outbox transfers as the architecture's merge plan describes. The client-side refine-before-send path is retired: it is the late-and-synchronous pattern this document rejects and cannot work offline. Manual pickers survive with a changed meaning — a manual choice is a settled value and a history entry, not a hint to the enricher. The Notion destination retires with the stopgap, replacing its category vocabulary with Cockpit's panels and associations.

**cockpit.** Part 1 needs the decision-history table; proposal state (origin, confidence, confirmed-at) on associations; a classification job on the existing enrichment queue; refresh-on-snapshot; the re-suggest command; and the nightly summary job with its settings screen. Part 2 adds an embedding per item, the client-side resemblance scan, and a group-filing command with group undo. All of it fits the existing shapes — commands, queue jobs, snapshot plus push invalidation — with no new infrastructure.

## 13. Open decisions

1. **Scope of the history: per workspace or global?** *Recommendation: per workspace* — it is the privacy boundary and the routing vocabulary genuinely differs between Work and Personal. Cost: cross-workspace patterns are not learned.
2. **Does the capture UI show proposals at all?** Fire-and-forget versus chips fading in a second after save. *Recommendation: fire-and-forget in v1*, being simpler and identical offline and online; revisit once proposals are demonstrably good.
3. **When does suggest-and-confirm flip to auto-apply?** The design makes the flip a default filter change. *Proposed trigger: a sustained acceptance rate above a chosen threshold*, visible in the instrumentation, rather than a gut call.
4. **Weighting of history entries.** Overrides should outweigh passive accepts, and old decisions should decay — a note re-filed weeks later is reorganisation, not correction. Exact weights are an implementation detail; without the principle, the system's own accepted proposals self-reinforce.
