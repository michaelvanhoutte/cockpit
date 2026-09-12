---
name: session-review
description: Cockpit's process for closing a long session - reading its own conversation back for every correction the user gave the agent, working out which rule would have prevented it, and opening a pull request with exactly those edits to this repository's own CLAUDE.md, a skill, or a doc. No product code. Use as the explicit last step before a long session ends, once real work has happened; skip it on a short session or one with no correction in it.
---

# Closing a session

A correction that never leaves the session teaches nobody but this one. "Record what made the last change take an afternoon" (pull request 73) and "Write down what the five-issue run cost" (pull request 112) each turned a session's corrections into rules only because someone re-read the transcript by hand afterward. This skill is that re-read, run at the point the session would otherwise be dropped.

## Process

### 1. Find the corrections

Read the conversation back — everything still in context. A session that was compacted has already lost whatever compaction dropped; that is a real gap, not one this step can close.

**A correction is the user rejecting, reversing, or redoing something the agent already did or proposed.** It is not a fresh instruction, an answer to a clarifying question, or scope added going forward — those move the work on rather than pointing at where it went wrong. The signal is what the message responds to: an action or claim already on the table, not an open question.

No correction found → say so and stop. No pull request.

### 2. Trace each correction to a rule

For each one: is there a rule already written in this repository's CLAUDE.md, a skill, or a doc that should have caught it? If so, it was simply skipped — note that for yourself and move on; restating a rule nobody followed would not have fixed it. Where none exists, draft the one that would have, in the voice of the file it is headed for.

### 3. Keep only what generalizes

**A rule earns a place only if the same mistake could recur on different work** — the test is whether it would have mattered before this session started, not whether it mattered in it. Most of what a session throws up is true of that piece of work and never again, or true only of how you personally like to work rather than of this repository; adding either lengthens a file this skill can't even reach in the second case, without helping the next session. Drop them, and name what was dropped with its one-clause reason in the pull request body — that is the only place it is written down, never a separate report.

Nothing survives → say so and stop, the same as step 1's empty case. No pull request.

### 4. Place and write each rule

Put it in the file actually read at the moment it matters: this repository's CLAUDE.md for anything a session needs before acting, a skill for anything that triggers on a task — the split CLAUDE.md draws for itself in "Say it in one place" — or a doc for the reasoning behind a decision, the way `scoping` sends Cockpit's own decisions to `functional-definition.md` and `architecture.md`. Name the incident in one clause; never retell it. Cite it the way every other rule here is cited: a quoted title and the number of the issue or pull request this session itself produced, where one exists; where the session shipped nothing of its own, name it in a clause with no number.

Where a surviving rule sharpens or replaces one already on the page — the way pull request 112 rewrote CLAUDE.md's "Run the review yourself before pushing" paragraph in place rather than adding beside it — edit that rule instead. Add a wholly new rule only where nothing already covers the ground it covers.

### 5. Open the pull request

No product code — the diff is CLAUDE.md, skills, and docs only, and it gets no issue of its own: the corrections it packages already happened, this only writes them down. Branch fresh off an up-to-date `main`: the session's own work may still sit on a branch carrying product code, or may already be merged, and either way this diff doesn't belong there. Commit, then follow this repository's own pull request discipline from here — draft, `/code-review` at the level CLAUDE.md's Tests table caps a documentation-only diff to (no `/security-review`, same table), mark ready, wait for checks. The body names what changed and where, per step 4, and what was dropped, per step 3; nothing else.

## Output

Either nothing — the session had no correction worth carrying, said plainly — or one pull request, no product code, every edit traceable to a correction this session actually contained.
