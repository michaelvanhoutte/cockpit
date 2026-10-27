---
name: session-review
description: Cockpit's process for closing a long session - reading its own conversation back for every correction the user gave the agent, keeping only the ones that are process rules, and asking which of them to write down as edits to this repository's own CLAUDE.md, a skill, or a doc. It asks first and drafts only what the person picks. No product code. `/build` runs it at the end of every run, so it only needs remembering outside `/build`: use it as the explicit last step before any other long session ends, once real work has happened; skip it on a short session or one with no correction in it.
---

# Closing a session

A correction that never leaves the session teaches nobody but this one. "Record what made the last change take an afternoon" (pull request 73) and "Write down what the five-issue run cost" (pull request 112) each turned a session's corrections into rules only because someone re-read the transcript by hand afterward. This skill is that re-read, run at the point the session would otherwise be dropped, and it asks before it writes, since a rule the person never takes costs a worktree, a review and a pull request for nothing.

It behaves the same wherever it runs, inside `/build` or by hand.

## Process

### 1. Find the corrections

Read the conversation back — everything still in context. A session that was compacted has already lost whatever compaction dropped; that is a real gap, not one this step can close.

**A correction is the user rejecting, reversing, or redoing something the agent already did or proposed.** It is not a fresh instruction, an answer to a clarifying question, or scope added going forward — those move the work on rather than pointing at where it went wrong. The signal is what the message responds to: an action or claim already on the table, not an open question.

**Where this session already merged a rules pull request, skip every correction its diff holds**, so a hand run after `/build` adds nothing twice. The session knows its number; read the diff rather than trusting memory.

No correction found → stop. No branch, no pull request, nothing written anywhere, and no line about it to the person.

### 2. Trace each correction to a rule

For each one: is there a rule already written in this repository's CLAUDE.md, a skill, or a doc that should have caught it? If so, it was simply skipped — note that for yourself and move on; restating a rule nobody followed would not have fixed it. Where none exists, work out the one that would have, in the voice of the file it is headed for.

### 3. Keep only process rules, at most three

This is the one filter, and zero survivors is the normal outcome.

**Only a process rule survives**: how the agent works on any task, such as when to ask, what to check, how to report. The test is whether the same mistake could recur on different work, and would have mattered before this session started, not whether it mattered in it. Drop, and write nowhere:

- a correction tied to one feature, library, surface or part of the product, since that is a decision for that work's own ticket or doc, and adding it would grow this repository's rules without end;
- a correction that is only how the person likes to work rather than how this repository does;
- a correction no different piece of work could repeat.

**Keep at most three, strongest first**: the ones that would have saved the most work, or recur most often. The rest are dropped, not queued.

Nothing survives → stop, the same as step 1's empty case: no question, no line to the person, nothing stored.

### 4. List the survivors and ask which to write

Nothing is drafted yet. Show each survivor as:

- **Your correction**, quoted in the person's own words.
- **What the agent will do differently**, one plain sentence, with no issue number, section number or internal term of the session's own work.
- **How often it would come up**, saying when, so a rule that applies to one situation reads as one.

Then ask which to write. Inside `/build` the list and the question are the last lines of the report, which stays last; by hand, the list and question end the session's last message the same way.

**No pick, or no answer → nothing is written and nothing is stored**: no worktree, branch, edit or pull request, and the suggestions are not kept for later. A session closed or compacted before the answer loses them, which is accepted.

### 5. Place and draft each picked rule

Draft only the rules the person picked. Put each in the file actually read at the moment it matters: this repository's CLAUDE.md for anything a session needs before acting, a skill for anything that triggers on a task — the split CLAUDE.md draws for itself in "Say it in one place" — or a doc for the reasoning behind a decision, the way `scoping` sends Cockpit's own decisions to `functional-definition.md` and `architecture.md`. Name the incident in one clause; never retell it. Cite it the way every other rule here is cited: a quoted title and the number of the issue or pull request this session itself produced, where one exists; where the session shipped nothing of its own, name it in a clause with no number.

Where a picked rule sharpens or replaces one already on the page — the way pull request 112 rewrote CLAUDE.md's "Run the review yourself before pushing" paragraph in place rather than adding beside it — edit that rule instead. Add a wholly new rule only where nothing already covers the ground it covers.

### 6. Write, check, open and merge the pull request

No product code — the diff is CLAUDE.md, skills, and docs only, and it gets no issue of its own: the corrections it packages already happened, this only writes them down. It never rides on the session's own branch, which may carry product code, be waiting for a person to merge, or be merged already: that pull request gains no commit, and a squash would fuse rule edits into a product commit.

**Write the edits in a worktree of their own, branched from freshly fetched `main`**, so the session's working tree is never touched; stashing to make room would take the stash shared with every other session.

```bash
git fetch origin main
git worktree add .claude/worktrees/session-review-<branch> -b session-review/<branch> origin/main
```

`<branch>` is the session's own branch name with its slashes as dashes, so two sessions finishing the same day never collide.

In that worktree: write step 5's edits, commit, run `pnpm test:scripts` and fix what it reports before going on, run `/code-review` at the level Review findings' own table gives a `documentation only` diff (`low`, no `/security-review`), then push and open it **ready, not draft**, since the person approved the content in chat. The body has one line per edit saying what changes for the agent, and nothing about the corrections declined.

```bash
gh pr create --title "..." --body-file <file>
```

**Wait for its checks with the waiter in CLAUDE.md, without the `session-record.mjs mark ci-*` lines**: the record times an issue, and a rules branch has none. A failing check is fixed and rechecked as for a product pull request, never merged red.

**Merge it whatever merge answer the session's own pull request got, but only when both hold just before the merge**:

- `node scripts/merge-recheck.mjs <number>` exits 0.
- `node scripts/local-changes.mjs` answers `documentation only`, so "no product code" is checked rather than promised.

If either fails, do not merge, and tell the person why. `gh pr merge` run from a worktree can print "main is already used by worktree" after the merge has landed: confirm with `gh pr view <number> --json state`. Then remove the worktree with `git worktree remove`.

## Output

Either nothing — the session had no process rule worth carrying, with no line about it — or a list of up to three suggestions and the question of which to write, and, after a pick, the number of the pull request that merged, no product code, every edit traceable to a picked correction.
