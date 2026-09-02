---
description: Say where this session is, without scrolling back for it
---

Report this session's position. At most eight lines, no preamble, no summary of the whole conversation, no offer to continue.

- **Issue** — number and title of the work in hand, or `none` if this session never picked one up.
- **Worktree** — the branch and the worktree directory.
- **Last instruction** — the user's most recent request, quoted or closely paraphrased. Theirs, not your restatement of the session.
- **Since then** — what you did about it, one line.
- **Outstanding** — what the definition of done still wants: tests, `/code-review`, a browser pass, review threads, CI.
- **Blocked on** — what you need from the user, or `nothing`.

Where the session drifted off the issue it started on, say so on the **Outstanding** line and name what got picked up instead.

Answer from what is already in context. This command is the cheap alternative to scrolling, so call nothing over the network — no `gh`, no check runs, no review threads — and resume no work. Where the state of CI or a review thread is not in context, say when you last saw it rather than going to look.
