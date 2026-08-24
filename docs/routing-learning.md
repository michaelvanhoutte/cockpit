# Routing that learns from past decisions (v0.1)

*Owner: Michael. Status: draft for discussion. Relates to: the functional definition (triage flow, panel rules, AI layer, the auto-tagging open decision) and the architecture document (read model, capture outbox, background jobs, AI layer, task-creator merge).*

## 1. Purpose

When a quickly captured note (typed, dictated in the car, sent by SMS) arrives in Cockpit, the system should propose where it belongs: which workspace, project, person or panel. Those proposals must get better over time by learning from where I actually file things, including corrections I make when I move an item out of the inbox to a different panel than the one proposed.

This document records how that works: the concepts, when each decision happens, what makes it, and what is deliberately not built.

## 2. The problem

The naive designs both fail:

- **Classify at capture time.** Breaks the capture performance budget (a note must be persisted in under two seconds), breaks offline capture entirely, and classifies with the least knowledge the system will ever have. Everything I teach it afterwards comes too late for that note.
- **Classify at triage time, synchronously.** The learning signal (how I filed the earlier notes of a batch) only exists mid-session, so the call for later notes would have to run while I wait in the UI. A model call takes one to three seconds; I triage at roughly two seconds per card. The wait would be intolerable and, worse, unbounded, because the system would effectively be waiting on my own earlier decisions.

The trap in both is the assumption that a classification is computed once and is then fixed. It is not. It is a derived value whose inputs keep changing, and the correct response to changing inputs is to recompute, not to postpone.

## 3. Design principle: model calls are free, waiting is forbidden

The goal was never to minimise model calls. Model calls at personal volume cost cents per day. The goal is that **no interaction ever blocks on one**. Every model call in this design runs at a moment when either nobody is looking at the screen, or the screen is already painted and usable and the call runs behind it.

Every model call in the system:

| When it fires | What it does | Who is looking at the screen |
|---|---|---|
| A note syncs in | proposes a routing, reading the full decision history | nobody (I am driving, walking, asleep) |
| The inbox is opened | refreshes proposals for everything not yet settled | me, but it runs behind the instant paint (see the slow-motion walkthrough below) |
| Nightly | rewrites the plain-English summary of my filing patterns | nobody |
| I press "re-suggest" on one item | reclassifies that item on demand | me, by explicit request, spinner accepted |

The last row is the one deliberate exception: a user-initiated action where a short wait is expected. It exists so that a stale proposal is never stuck, which is what makes the rest safe to run asynchronously.

## 4. Concepts

**Item.** A captured note once it exists in Cockpit. The same Item as everywhere else in the product's data model.

**Routing.** The subset of an Item's associations that determine where its card shows up: workspace, project, person, topic, panel.

**Proposed vs settled.** Every routing value is in one of two states. *Proposed*: the system put it there and I have not looked at it. *Settled*: I decided it, either by accepting the proposal or by choosing something else. This distinction carries the whole design.

**Decision history.** An append-only record of every settled routing: the note text, what the system proposed, what I chose, and how (accepted, overridden, manual). It grows by one entry every time I settle something. It is the only place learning lives; there is no training step and no separate feedback action.

## 5. The rule

> **A proposed routing may be replaced by the system at any time, without asking. A settled routing may only ever be changed by me.**

Consequences:

- "When should the system classify?" stops being a hard question. The answer is: as often as it usefully can, because a proposal commits nothing.
- Background recomputation can never destroy a human decision, so recomputation and triage can run concurrently without coordination.
- Proposals do not populate panels. A card appears in a Project or Person panel only once its routing is settled. This answers the auto-tagging open decision in the functional definition as suggest-and-confirm; flipping to auto-apply later is a change to a default filter, not to the architecture.
- This extends the existing schema discipline of source-owned versus app-owned columns with a third group: system-proposed values, overwritable by background jobs until a human touches them, never after.

## 6. The decision moments

| Moment | What is decided | By what | Binding? | Am I waiting? |
|---|---|---|---|---|
| 1. I capture a note | nothing | | | no |
| 2. The note syncs | a proposed routing | model, background job | no | no |
| 3. I open the inbox | proposals refreshed for all unsettled items | model, background job | no | no |
| 4. I triage an item | the routing settles; one history entry appended | **me** | **yes, permanently** | no |
| 5. Nightly | plain-English summary of my patterns rewritten | model | routes nothing | no |

**Moment 1** stores the note locally and nothing else. This must stay true: there may be no connectivity, and the note must be safe within the capture budget. This is the existing capture outbox, unchanged.

**Moment 2** is the first classification: the model reads the note, the panel definitions (which are already plain-English sentences per the panel-rules design), the nightly summary, and the decision history. It runs through the existing queue-based enrichment path, alongside the other on-ingest AI work.

**Moment 3** is what makes learning land. Between my triage sessions lie hours or days; proposals made at moment 2 may predate corrections I have made since. So on inbox open, everything unsettled is re-proposed against the current history. By the time I read a card more than a couple of seconds in, its proposal reflects everything I have taught the system up to this session. The slow-motion walkthrough below shows why this never makes me wait.

**Moment 4** is the only binding moment and the only source of learning. Accepting and overriding both settle the routing and both append to the history; an override is the stronger signal because it records the rejected answer and the correct one.

**Moment 5** exists for two reasons: it keeps the model's input bounded as the history grows, and it makes what the system has learned *visible and editable*. The summary renders in settings as plain English ("notes about validation, audit trails and sign-off go to Compliance questions, even when they name a person") and I can correct it in a sentence. This is the same philosophy as plain-English panel rules, applied to learned behaviour: no black box, no rule wizard.

## 7. Moment 3 in slow motion

Because this is where "a model call when the inbox opens" and "I never wait" have to coexist:

1. I open the inbox. It paints **instantly from the persisted local snapshot** (the existing read model), which already carries the proposals made at moment 2. Nothing is requested before paint.
2. At the same instant, the server begins refreshing proposals for unsettled items. This takes one to two seconds in total.
3. Results stream back over the existing push channel and update proposal chips **below my current position** in the list, never at or above it, and never in the same frame as a layout reflow. Chips must not change under my eyes.
4. Meanwhile I am already triaging the first card.

The inbox never waits for the refresh; the refresh never waits for the inbox. They start together, and since I read at seconds per card while the refresh completes in a second or two, the refresh wins the race unnoticed. Worst case, the first card or two show the moment-2 proposal, which was produced by the same model reading the same history, only slightly older. The refresh changes an answer only when I taught the system something relevant after that note arrived.

## 8. What the model reads: the whole history, no retrieval

**Decision: there is no search or retrieval step in this design.** The decision history is not a database the system queries for "similar" past notes. It is text, included in the model's input in full.

The reasoning, recorded because the alternative looks more sophisticated and is worse:

- Retrieval (by embedding similarity or keyword match) exists to cope with corpora too large to show a model. It is a lossy compromise, never an improvement: any retrieval step can only discard information before the model sees it.
- At personal capture volume the corpus is small. A history entry is a short note plus a destination, roughly 25 tokens. A year of heavy use is on the order of 50,000 tokens, comfortably inside the model's context window. The history is a stable, append-only prefix, the ideal shape for prompt caching, so recurring cost stays low.
- Reading everything is strictly better at the hard cases: notes that share meaning but no words ("Part 11 audit trail" versus "validation protocol, who signs off"), panels defined by something other than topic ("urgent", "do at home"), and Dutch or mixed Dutch-English notes. Every similarity measure struggles with at least one of these; a model reading the panel definitions and the full history handles all three.

The scaling ladder, if the history ever genuinely outgrows the prompt:

1. **Now: full history in the prompt.** Nothing to build or tune.
2. **Later: nightly summary plus the most recent decisions.** The summary is a semantic compression written by a model that read everything, and I can inspect and correct it. Better than retrieval, which compresses by discarding.
3. **Only if that proves lossy: add retrieval.** May never be reached.

## 9. Part 2 (optional, measurement-gated): in-session carry-over

Part 1 (everything above) is complete and shippable on its own. It closes the cross-session loop: corrections made today improve proposals from tomorrow on. One gap remains.

**The gap.** Within a single triage session, I might correct item 1 and reach item 5 eight seconds later. Item 5's proposal was refreshed at moment 3, before that correction. No model call can update it in time: the budget is under a second, inside a picker, possibly offline. This is the one place in the design where a model call genuinely cannot fit, and therefore the only place a different mechanism is justified.

**The mechanism.** When I file an item into a panel, the client looks at the unsettled notes below it in the queue, finds those that textually resemble the one just filed, and offers them the same destination inside the panel picker I already have open: "also move: [note], included, one keystroke to exclude". Confirming files the group as **one command**, so one undo reverses all of it. Resemblance is computed locally in the browser (embeddings shipped in the snapshot, a dot-product scan, about a millisecond over a few thousand notes), so it works offline and is ready before I have finished choosing a panel.

One non-obvious rule: when the filing was an *override*, the features behind the rejected proposal must be excluded from the resemblance scoring. If the system proposed "Laurens" and I chose "Compliance questions", then "Laurens" was demonstrably not the deciding signal, and matching on it would drag genuine Laurens items into Compliance.

**Why this stays separate from Part 1:**

- It rests on an assumption Part 1 does not: that textual resemblance predicts co-destination for my notes. That is measurable, not arguable (see the measurements section).
- It structurally cannot learn non-topical panels; Part 1's model can, via the panel definitions.
- Its failure is asymmetric and tunable: too cautious means it offers nothing and I file by hand (zero regression); too eager means wrong items ride along on a fast confirm (real cost, mitigated by a conservative threshold, group undo, and a toast naming what came along).

**Embeddings exist only for this.** Part 1 uses none. If Part 2 is never built, no embeddings are needed anywhere. Computing and storing them from day one is still cheap insurance: it enables the offline measurement below without a backfill, and nothing consumes them until Part 2 exists.

## 10. Measurements gating Part 2

Two numbers replace opinions:

1. **Offline, before building anything.** The existing task-creator Notion database is a labelled corpus: note text plus the category each note ended up with. Embed every note, and for each one check whether its nearest textual neighbour shares its category. That percentage is the ceiling on carry-over precision. High (roughly 80% or more): worth building. Low: don't, and the question is closed for the cost of an afternoon script. Run it separately for Dutch notes, since small embedding models are English-trained and this is the likeliest weak spot.
2. **Live, after shipping Part 1.** Instrument one event: how often a correction in a session is followed, in the same session, by another item that correction would have re-routed. That frequency is the actual value of carry-over, measured on real behaviour. If it is rare, Part 2 is not worth its complexity regardless of measurement 1.

## 11. Build order

1. **Part 1**: decision history, proposed/settled states on associations, classification job at moments 2 and 3, the re-suggest action, the settings screen showing the summary. Delivers the original requirement: it learns from previous tasks, including inbox corrections.
2. **Instrument** the two measurements above.
3. **Part 2** (carry-over), only if the numbers justify it.
4. **The summary as prompt input** (step 2 of the scaling ladder), only when history size demands it. The summary *screen* ships in step 1; this step is only about swapping it into the prompt in place of the full history.

## 12. Consequences for the two codebases

**task-creator.** The capture outbox transfers as designed in the architecture's task-creator merge plan. The client-side refine-before-send path (the refine endpoint and WYSIWYG enrichment) is retired: it is the late-and-synchronous pattern this document rejects, and it cannot work offline. Manual pickers (category, priority, due date) survive, but their meaning changes: a manual choice is a settled value and a history entry, not a hint to the enricher. The Notion destination retires with the stopgap, which also means the current category vocabulary and its auto-create behaviour are replaced by Cockpit's panels and associations.

**cockpit.** Part 1 needs: the decision-history table; proposal state (origin, confidence, confirmed-at) on associations; a classification job consuming the existing enrichment queue; refresh-on-snapshot; the re-suggest command; the nightly summary job and its settings screen. Part 2 adds: an embedding per item (computed on ingest, shipped in the snapshot), the client-side resemblance scan, and a group-filing command with group undo. All of it fits the existing shapes: commands, queue jobs, snapshot plus push invalidation. No new infrastructure.

## 13. Open decisions

1. **Scope of the history: per workspace or global?** Recommendation: per workspace. The workspace is the privacy boundary, and the routing vocabulary genuinely differs between Work and Personal. Cost: cross-workspace patterns are not learned.
2. **Does the capture UI show proposals at all?** Fire-and-forget (all intelligence surfaces later in the inbox) versus chips fading in a second after save as confirmation the note was understood. Fire-and-forget is simpler and identical offline and online; the confirmation variant is reassuring but behaves differently without connectivity. Recommendation: fire-and-forget in v1; revisit once proposals are demonstrably good.
3. **When does suggest-and-confirm flip to auto-apply?** (An open decision in the functional definition.) The design makes the flip trivial (a default filter change). Proposed trigger: sustained acceptance rate above a chosen threshold, visible in the instrumentation, rather than a gut call.
4. **Weighting of history entries.** Overrides should outweigh passive accepts (a fast accept is weak evidence), and old decisions should decay (a note re-filed weeks later is reorganisation, not correction). Exact weights are an implementation detail, but the principle belongs here: without it, the system's own accepted proposals self-reinforce.
