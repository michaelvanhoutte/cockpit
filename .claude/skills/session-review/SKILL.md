---
name: session-review
description: Cockpit's process for closing a long session - reading its own conversation back for every correction the user gave the agent, working out which rule would have prevented it, and opening a pull request with exactly those edits to CLAUDE.md, a skill, or a doc. No product code. Use as the explicit last step before a long session ends, once real work has happened; skip it on a short session or one with no correction in it.
---

# Closing a session

A correction that never leaves the session teaches nobody but this one. "Recover from an expired sign-in instead of failing silently" (pull request 71) and "Write down what the five-issue run cost" (pull request 112) each turned their own corrections into rules only because someone re-read the transcript by hand afterward. This skill is that re-read, run at the point the session would otherwise be dropped.

## Process

### 1. Find the corrections

Read the conversation back — everything still in context. A session that was compacted has already lost whatever compaction dropped; that is a real gap, not one this step can close.

**A correction is the user rejecting, reversing, or redoing something the agent already did or proposed.** It is not a fresh instruction, an answer to a clarifying question, or scope added going forward — those move the work on rather than pointing at where it went wrong. The signal is what the message responds to: an action or claim already on the table, not an open question.

### 2. Stop here if there is nothing

No correction, or nothing past the filter in step 4 → say so and end. No pull request. A short session and an empty one look the same to this step; length is not what is being measured.

### 3. Trace each correction to a rule

For each one: which already-loaded rule should have caught it? A rule that exists and was simply skipped gets noted, not duplicated — that is a rule not followed, and proposing it again would not have fixed it. Where none exists, draft the one that would have, in the voice of the file it is headed for.

### 4. Keep only what generalizes

**A rule earns a place only if the same mistake could recur on different work** — the test is whether it would have mattered before this session started, not whether it mattered in it. Most of what a session throws up is true of that piece of work and never again; adding those lengthens the file without helping the next one. Drop them, and name what was dropped with its one-clause reason in the pull request body — that is the only place it is written down, never a separate report.

### 5. Place and write each rule

Put it in the file actually read at the moment it matters — CLAUDE.md for anything a session needs before acting, a skill for anything that triggers on a task, a doc for the reasoning behind a decision — the placement CLAUDE.md already states for itself. Name the incident that produced it in one clause; never retell it.

Where a surviving rule sharpens or replaces one already on the page — the way pull request 112 folded two findings into existing testing-skill rules instead of appending — edit or delete that rule rather than adding beside it. Add a wholly new rule only where nothing already covers the ground it covers.

### 6. Open the pull request

No product code — the diff is CLAUDE.md, skills, and docs only, and it gets no issue of its own: the corrections it packages already happened, this only writes them down. Commit, then follow this repository's own pull request discipline from here — draft, self-review with `/code-review`, mark ready, wait for checks. The body names what changed and where, per step 5, and what was dropped, per step 4; nothing else.

## Output

Either nothing — the session had no correction worth carrying, said plainly — or one pull request, no product code, every edit traceable to a correction this session actually contained.
