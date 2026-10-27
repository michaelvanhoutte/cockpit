---
description: Say where this session is, without scrolling back for it
---

Report this session's position. At most eight lines, no preamble, no summary of the whole conversation, no offer to continue.

- **Issue** — number and title of the work in hand, or `none` if this session never picked one up.
- **Worktree** — the branch and the worktree directory.
- **Last instruction** — the user's most recent request, quoted or closely paraphrased. Theirs, not your restatement of the session.
- **Since then** — what you did about it, one line.
- **Pull request** — its number and state as you last saw it (draft, ready, merged), or `none yet`.
- **Outstanding** — what the definition of done still wants: tests, `/code-review`, a browser pass, review threads, CI. Where the issue has a statement list, say how many of its statements are covered and how many are not.
- **Follow-ups** — what was set aside rather than done here: chips spawned, changes the user asked for after verifying, suggestions you made at the end of a build. Name each in a few words and say whether it was handed to another session or is still only noted, or `none`.
- **Blocked on** — what you need from the user, or `nothing`.

Where the session drifted off the issue it started on, say so on the **Outstanding** line and name what got picked up instead.

Answer from what is already in context. This command is the cheap alternative to scrolling, so call nothing over the network — no `gh`, no check runs, no review threads — and resume no work. Where the state of CI or a review thread is not in context, say when you last saw it rather than going to look.
