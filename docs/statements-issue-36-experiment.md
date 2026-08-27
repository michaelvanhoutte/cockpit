# Statement list for issue #36 (experiment)

**Status:** experiment, not a decision. Delete when the experiment is done. The method
that produced it is in `testing-decisions-wip.md`, section "How a statement list is
generated".

## How to review

Each item is a **rule** in product language with the **cases** that exercise it. One
rule is one test body; the cases are a table inside it. What the runner prints per
case is a plain-English statement, and those printed lines are the statement list.
Nothing separate is stored.

Levels, in the words the testing strategy uses: **integration** is the API running in
process against a real local database; **frontend unit** replaces the backend;
**frontend plus its own backend** uses the real one; **end to end** is a real browser
against the whole stack.

*(inferred)* marks a case that follows from the issue rather than appearing in it.

---

## Backend rules

### Panel contents `integration`

**A panel shows exactly the actions assigned to it, and the Inbox exactly the ones assigned to no panel.**

Checked against the panels involved and the Inbox. Not against the action list, which
filters by workspace only and so cannot differ.

- created on panel A → on A, not in the Inbox
- created with the dashboard's add button → in the Inbox only
- assigned to A from the Inbox → on A, out of the Inbox
- assigned to B as well → on A and B
- assigned to a panel on another dashboard → on both *(inferred)*
- moved from A to B → on B only *(cut at build time if a move is a remove plus an add rather than its own command)*
- removed from B while also on A → on A only
- removed from A, its only panel → back in the Inbox *(inferred)*
- deleted → on no panel, not in the Inbox, and gone from the action list

### The Inbox is fixed `integration`

- a rename of the Inbox → rejected
- a delete of the Inbox → rejected

### Inbox visibility `integration`

**Showing the Inbox is a per-dashboard setting, off by default.**

- a newly created dashboard → hidden
- turned on for dashboard 1 → shown on 1, still hidden on 2 *(inferred)*

### Panel identity `integration`

**Assignments are keyed to the panel, not to its name.**

- panel A renamed → the same actions are still on it
- panel A deleted → **open question 1**, the issue does not say

### Repeated commands `integration`

**A repeated command changes nothing the second time.**

- the same create sent twice → one action
- the same assign sent twice → assigned once, not twice

### Invalid commands `integration`

**An invalid command is rejected and writes nothing.**

The table grows as validation rules arrive, and no test is added when it does.

- a create with no title → rejected, nothing written

### Workspace isolation `integration`

**A workspace never sees another workspace's data.**

Checked on each distinct query: panel contents, the Inbox, the action list, an action
fetched by id.

- an action in another workspace → absent from all four

---

## Frontend rules

### Creating an action `frontend unit`

**Every place that creates an action sends the right create.**
- a panel's add button → a create for that panel
- the dashboard's add button → a create with no panel

### Opening the editor `frontend unit`

**Double clicking an action opens the editor.**

### Rendering an action `frontend unit`

**A panel shows an action's short title, not its description.**

### Empty panels `frontend unit`

**An empty panel and an empty Inbox still render.**

### The Assign to modal `frontend unit`

**Assign to opens with the tree and puts recent targets first.**
- right click → the modal opens with a tree of dashboards and panels
- after assigning → that panel is first in the recent list *(inferred; see question 7)*
- after four assignments → three shown, the oldest dropped *(inferred)*
- nothing to show → the empty tree still renders

### Drop prompt `frontend unit`

**Dropping an action on another panel prompts, and sends what was chosen.**
- choose move → a move is sent
- choose add → an add is sent
- cancel → nothing is sent

### Dragging between dashboards `frontend unit`

**Dragging over another dashboard's name switches to it.**

### Failed commands `frontend unit`

**A command that fails puts the screen back as it was.**
One case, unless the commands stop sharing one client.
- an assign that fails → the action is back on its original panel

### Showing errors `frontend unit`

**A rejected command shows the error the backend returned.**
One case covers every validation rule, now and later.

### The action list page `frontend unit`

**It renders every action as a plain table.**

### Live refresh `frontend plus its own backend`

**Open panels refresh when the server signals a change.**

---

## End to end

### The core loop `end to end`
Create from the dashboard button, assign it to a panel with Assign to, watch it leave
the Inbox, complete it, and see it completed on a second panel that also holds it.

### Drag and drop `end to end`
Drag an action to another panel, choose move, see it on the target and gone from the
source.

---

## Cut, and why

Recorded because the reasons are the material for the skill's pruning pass.

| Cut | Reason |
|---|---|
| The rule that a change to an action is visible everywhere it appears | One record, one copy, no query that could return a different title. The real claim was that other panels *see* it, which is F11 and E1. |
| The rule that when two changes race, the later one wins | Already covered by the existing unit test on staleness. If per-field last-write-wins ever lands, that unit test is what has to grow. |
| Checking the action list on every panel-contents case | It filters by workspace, not by assignment, so only deletion changes what it returns. |
| Assigned twice does not duplicate | Moved into the repeated-commands rule, where it actually lives. |
| Two panels with the same name keep separate assignments | Same claim as rename-keeps-assignments; both prove keying by id. |
| Turned the Inbox off again → hidden | Same setter as turning it on. |
| Right click in the Inbox, double click in the Inbox | Same component as on a panel. |
| An overlong title is truncated | That is CSS, and a test asserting it asserts a stylesheet. |
| Several hundred actions render and scroll | Performance, not correctness, and slow. Better looked at once by hand. |
| Whitespace-only title rejected | Only distinct if trimming is a rule. #33 trims panel names; nothing says so for action titles. Question for Part C. |

---

## Part C. What the issue does not answer

1. **What happens to an action when its panel is deleted?** #33 allows deleting a
   panel and #36 does not say. It is a missing case in the panel-identity rule.
2. **Does a completed action stay on the panel?** Whether it disappears, greys out,
   or moves.
3. **In what order do actions appear inside a panel?** Nothing says, and manual
   ordering would add both a model and a rule.
4. **Is deleting confirmed, and can a delete or a move be undone?**
5. **Can an action be created from the Inbox or the action list page?** That would
   add cases to F1.
6. **Can Assign to target several panels at once?** That would add a case to the Assign to rule.
7. **Are the three recent targets remembered per workspace, per dashboard, or across
   everything?** This decides whether the recent-target cases are frontend or backend.
8. **Can an action be dragged onto the Inbox to unassign it?** A case in the panel-contents rule and the drop-prompt rule.
9. **Is archiving a third thing** next to delete and remove-from-panel?
10. **Are action titles trimmed?** Decides whether the invalid-command rule gains a case.

---

## Counts

20 rules and about 35 cases: 7 backend, 11 frontend, 2 browser walks.

Where it came from: 47 flat statements, then 55 once split by claim, then 22 rules and
70 cases, then this. The rule count barely moved in the last pass; the case count
halved. The padding was inside the tables, not in the rules.
