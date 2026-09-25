# Learning how you write (v0.1)

*Owner: Michael. Status: draft for discussion. Relates to `routing-learning.md`, which does the same for where a note is filed; the functional definition ("AI layer: executive summaries and highlights"); and the architecture document ("AI layer", "Background jobs", "Schema conventions").*

## Purpose

Cockpit proposes a title and a description for every captured note. This says how those proposals learn from what you actually write, what is stored to make that possible, and what is deliberately not.

The other half of the same model call — which Panel a note belongs on — already learns this way, and `routing-learning.md` is its record. Nothing here is a new idea; it is that design applied to the half that never got it.

## What is wrong today

Measured against 29 notes with the title and description their author would have written:

| | The prompt as measured (v5) | What was wanted |
|---|---|---|
| Title length | "at most 200 characters" | 17–55 characters, mean 31, from notes averaging 92 |
| Title register | a noun phrase naming the note | an imperative naming the work — "Run only impacted CI tests" |
| Description | "the note written out as prose" | an instruction to do the thing |
| Unstated detail | "say that the note does not say which" | never hedged once, across all 29 |

Every one of those is fixable by rewriting the prompt. One thing is not: **the wanted titles use their author's vocabulary, not the note's words.** "conselit" becomes "Conselit"; "check if the functional definition should stay one document" becomes "Verify if functional definition should be split", inverting the polarity; "alle issues in 1 keer fixen" becomes "Onboarding procedure stroomlijnen", a word the note never contains. No prompt can supply that, because it is not general knowledge. Only evidence of how this person actually writes can.

## Four ways to teach it

| | Effort | Volume | Signal quality | What only it can express |
|---|---|---|---|---|
| Settled titles | none | every edit, forever | noisy — mixes style fixes, model errors, and changing your mind | your live vocabulary, free |
| Curated examples | high per row, one-off | as many as you write | highest, every row deliberate | a rule isolated in a clean case |
| Like / dislike | one tap | only when you remember | lowest | little |
| Rules in words | one sentence | tiny | highest per token | prohibitions |

**Only settled titles remain.** Curated examples and rules in words were built and then retired ("Remove the two learning settings screens, and the commands that write to them", issue 452): Cockpit learns purely from what you do, and nothing you write by hand steers it.

**Like and dislike are already given for free, and better.** Not editing a suggestion is a like; editing it is a dislike *and* the right answer for that exact note. A paired negative beats an unpaired one, so the button is strictly worse than the edit somebody makes anyway. What the button was protecting — that a corpus of good answers never records the bad ones — is answered by storing the proposal alongside the correction, which is what "Learn where notes belong from where you actually file them" (issue 299) already does for Panels.

## The rules

> **A proposed text may be replaced by Cockpit at any time. A text you settled may only ever be changed by you.**

Unchanged from `routing-learning.md`, "The rule", and already enforced: `applyProposedTexts` refuses any Item whose `textsSettledAt` is set.

> **An Item you never saw says nothing. An Item that stood says something, and less than a correction does.**

A record of corrections alone is a record of failures with no denominator. Nothing in it separates forty corrections out of four hundred proposals from forty out of fifty, so the model reads only the cases where it was wrong and cannot tell a rare edge case from systematic failure. It also starves on its own success: the better the proposals get, the fewer corrections there are left to learn from.

So what stood is counted and sampled as well, and labelled as the weaker evidence it is. A text nobody changed means "good", "tolerable" or "I was triaging fast", which is why it never outranks a correction — but an Item still sitting unseen in the Inbox has not been judged at all, and counts in neither direction.

The cost of counting what stood, stated plainly: a bad text you tolerated rather than fixed is counted as a weak positive. **Try again** is what gets one out of that bucket for the price of a tap, which is the whole reason it is worth a control of its own while a dislike button is not.

## What is stored

One table, per account, two kinds of row:

| Kind | The note | What Cockpit proposed | What you settled on |
|---|---|---|---|
| **Edited** — you changed a proposed text | yes | yes | yes |
| **Rejected** — you asked for another suggestion | yes | yes | — |

**The proposal is frozen at your first edit; your side stays live.** One row per Item, written the moment you first change either text, holding whatever Cockpit had proposed. Later edits to the same Item update the row's settled half rather than appending another, so the record always carries what you finally arrived at rather than a half-finished first pass. This is where it departs from `decision_history`, which is append-only because a filing is one act — editing a text is not.

**The note's text is stored on the row, not joined from the Item.** A row must outlive an Item that has since been deleted.

**What stood is derived, not stored.** An Item whose texts Cockpit proposed and nobody has changed already *is* that fact, and storing a row for each would mean a row per Item ever captured. The count and the sample are read from `items` directly. That needs one new column — when the texts were proposed — so a proposal can be told from the mechanical title capture writes when enrichment never ran, which is otherwise indistinguishable and would put notes Cockpit never read into the denominator.

**Nothing carries an embedding**, and there is no retrieval step, for the reasons already settled under "What the model reads: bounded, no retrieval" in `routing-learning.md`.

## What goes into the prompt

Three sections, in a stated order of precedence, each bounded to a plain rolling 30-day window ("Cap the text-learning prompt to the last 30 days, and drop rules and pinned examples as inputs", issue 451) — unlike routing's own cap, writing style has no panel or project of its own to key staleness off:

1. **Corrections** — rendered as `"<note>" — Cockpit wrote "<title>", you changed it to "<title>"`, most recent last. A correction names a wrong answer as well as a right one, so it is the stronger signal, exactly as an override is for filing. No minimum count: even one in the window is shown.
2. **What stood** — a sample of the texts nobody changed, under a line saying how many were proposed and how many of those were corrected. Shown only once at least 3 stood in the window; below that, the whole section is simply absent, since a sample that small is a coin flip rather than a pattern.
3. **Rejections** — a wrong answer with no right one beside it. Not yet built (see "Try again" under "Build order" below); the same 30-day window applies once it is.

If a window carries nothing qualifying for a section - or, for what stood, not enough - that section is simply absent from the prompt. Nothing forces older data in to fill the gap.

**Your rules and pinned examples are not prompt inputs, and cannot be written.** Cockpit learns purely from what you actually do; the screens and commands that wrote them are gone ("Remove the two learning settings screens, and the commands that write to them", issue 452). Their tables keep the rows they hold until "Drop the `account_text_rules` table" (issue 453) and "Drop the `pinned_text_examples` table" (issue 454) remove them.

**That ratio is the point of the second section, more than the sample under it.** It is what stops a handful of corrections reading as systematic failure, and it is the one input here that gets better as the proposals do rather than drying up with them.

**The sample stays a sample.** Once the proposals are any good, what stood outnumbers what was corrected by an order of magnitude, and rendering all of it would drown the stronger signal in the weaker one.

The prompt's own built-in examples stay. They teach the language rule, the other-readings rule and the Panel rule, which style evidence does not.

## Where you see it

**There is no screen for it yet, and nothing here is yours to write.** What shapes a title is Cockpit's own guidance and the evidence above, and the evidence is what you did. Showing that evidence, with a control to correct it, is unbuilt: a screen that only logs what was recorded is not a control, and a log with a delete button is not one either ("Try the corrections window on screen before building it", issue 393). Anything that lands here has to earn its place with something to act on, and a correction row reads its settled half live from the Item, so a row teaching the wrong thing is fixed by re-editing that Item's title.

## What Cockpit says about itself

A per-Item reason explains one decision and never says what rule is being followed; reading forty of them still does not. So Cockpit's account of what it has learned is written **for the whole account, on demand, when you open the screen** — and stored nowhere.

That is the deliberate difference from "Show what the system learned, in a sentence you can correct" (issue 301), which this design removes. Its summary was generated nightly, persisted, shown read-only, and fed into nothing, while the correction beside it was labelled as a footnote to that summary and was secretly the highest-ranked input in the system. Generating on demand leaves nothing to go stale, nothing to overwrite, and no second text competing with what you do.

The Panel chip's own hover reason stays. It is not explanation of a rule but decision support at the moment of choosing, and without it the chip is a bare assertion.

## Scope: per account

**Per account, deliberately unlike filing.** How you write is a property of you; where you file is a property of the Workspace, which is why "Learn where notes belong from where you actually file them" (issue 299) scoped the decision history per Workspace and this does not.

The cost is real and was accepted knowingly: a Personal note's full text is sent to the model while you are capturing in Work, which is the crossing that decision refused. Nothing else about the Workspace boundary moves — Panels, filing history and the proposals themselves stay exactly where they are.

## Build order

1. ~~**Prompt v6** — task register, a title target near 50 characters against the 200-character cap that stays a storage limit, and the hedge instruction dropped.~~ **Shipped** ("Propose a title that names the work, not the note", issue 391); the target is asked for as a ceiling, since "about 50" is not something a test can hold a model to. Independent of everything below.
2. ~~**Remove the nightly half of issue 301** — the fan-out, the summary prompt and its contract test, `write_routing_summary`, the read-only summary. The Cron Trigger itself stays; it also resets the guest account.~~ **Shipped** ("Drop the nightly filing summary, keep the sentence you wrote", issue 392); `summary`/`summary_generated_at` keep what they hold and are read by nothing, which the `workspace_routing_summary` drop below removes.
Both of the above have shipped. What is left, named rather than numbered so that citing one cannot rot into a wrong number:

| Step | What it does | After |
|---|---|---|
| **The store** | The triple recorded at your first edit, the count and sample of what stood read from `items` beside it, prompt v8 reading both, each capped to the last 30 days ("Cap the text-learning prompt to the last 30 days, and drop rules and pinned examples as inputs", issue 451). Headless — it changes what titles say, and puts up no screen. | prompt v6 |
| **The evidence** | What it got right and what you corrected, as two lists on a screen — the sample of what stood, and the pairs with Cockpit's version struck through. | the store |
| **Re-read the Inbox** | Correcting a text re-proposes everything still unfiled, as "Re-propose the rest of the inbox the moment you file one" (issue 300) already does for Panels. | the store |
| **Try again** | A fresh suggestion now, the rejected one recorded — and what gets a tolerated-but-wrong title out of the sample that stood. | the store |
| **Drop `workspace_routing_summary`** | Expand-then-contract, `pnpm backup:export` first, and only once the steps that stopped reading it are live rather than merged. | the nightly half removed |
| **Cockpit's account of itself** | Generated when you open the screen it needs, stored nowhere. | a screen |

## Open decisions

1. ~~How big the sample of what stood should be, and what is dropped first when the rest outgrows the prompt.~~ **Resolved** ("Cap the text-learning prompt to the last 30 days, and drop rules and pinned examples as inputs", issue 451): a plain rolling 30-day window, since writing style has no panel or project of its own to key staleness off the way routing does — no minimum for corrections, and a floor of 3 below which what stood is omitted entirely rather than shown as a coin flip.
2. **Whether an edit needs to say which kind it was.** "Onboarding procedure stroomlijnen" is not a style correction — it reinterprets the note — and stored as style evidence it teaches the model to invent a verb. One tap at the moment of editing, *fixed the wording* against *changed what it's about*, would separate them. *Recommendation: measure how often it matters before building it, rather than adding a tap to every edit on a suspicion.*
3. **Whether filing should get a rules block of its own.** It is the only way to state a rule Cockpit has not yet seen you follow. *Recommendation: leave it out until it is missed — filing already learns from what you actually do, which is the objection that removed the nightly summary in the first place.*
