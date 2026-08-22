# Statement list for issue #36 (experiment)

**Status:** experiment, not a decision. Delete when the experiment is done. The method
that produced it is in `testing-decisions-wip.md`, section "How a statement list is
generated".

## How to review

Each item is a **rule** in product language with the **cases** that exercise it. One
rule is one test body; the cases are a table inside it. What the runner prints per
case is a plain-English statement, and those printed lines are the statement list.
Nothing separate is stored.

Levels: L2 integration (the API in process against a real local database), F1
frontend unit, F2 frontend plus its own backend, F3 end to end.

*(inferred)* marks a case that follows from the issue rather than appearing in it.

---

## Backend rules

### R1 `L2` A panel shows exactly the actions assigned to it, and the Inbox exactly the ones assigned to no panel

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

### R3 `L2` The Inbox is fixed

- a rename of the Inbox → rejected
- a delete of the Inbox → rejected

### R4 `L2` Showing the Inbox is a per-dashboard setting, off by default

- a newly created dashboard → hidden
- turned on for dashboard 1 → shown on 1, still hidden on 2 *(inferred)*

### R5 `L2` Assignments are keyed to the panel, not to its name

- panel A renamed → the same actions are still on it
- panel A deleted → **open question 1**, the issue does not say

### R6 `L2` A repeated command changes nothing the second time

- the same create sent twice → one action
- the same assign sent twice → assigned once, not twice

### R8 `L2` An invalid command is rejected and writes nothing

The table grows as validation rules arrive, and no test is added when it does.

- a create with no title → rejected, nothing written

### R9 `L2` A workspace never sees another workspace's data

Checked on each distinct query: panel contents, the Inbox, the action list, an action
fetched by id.

- an action in another workspace → absent from all four

---

## Frontend rules

### F1 `F1` Every place that creates an action sends the right create
- a panel's add button → a create for that panel
- the dashboard's add button → a create with no panel

### F2 `F1` Double clicking an action opens the editor

### F3 `F1` A panel shows an action's short title, not its description

### F4 `F1` An empty panel and an empty Inbox still render

### F5 `F1` Assign to opens with the tree and puts recent targets first
- right click → the modal opens with a tree of dashboards and panels
- after assigning → that panel is first in the recent list *(inferred; see question 7)*
- after four assignments → three shown, the oldest dropped *(inferred)*
- nothing to show → the empty tree still renders

### F6 `F1` Dropping an action on another panel prompts, and sends what was chosen
- choose move → a move is sent
- choose add → an add is sent
- cancel → nothing is sent

### F7 `F1` Dragging over another dashboard's name switches to it

### F8 `F1` A command that fails rolls the screen back
One case, unless the commands stop sharing one client.
- an assign that fails → the action is back on its original panel

### F9 `F1` A rejected command shows the error the backend returned
One case covers every validation rule, now and later.

### F10 `F1` The action list page renders every action as a plain table

### F11 `F2` Open panels refresh when the server signals a change

---

## End to end

### E1 `F3` The core loop works in a browser
Create from the dashboard button, assign it to a panel with Assign to, watch it leave
the Inbox, complete it, and see it completed on a second panel that also holds it.

### E2 `F3` Drag and drop works in a browser
Drag an action to another panel, choose move, see it on the target and gone from the
source.

---

## Cut, and why

Recorded because the reasons are the material for the skill's pruning pass.

| Cut | Reason |
|---|---|
| R2, a change to an action is visible everywhere it appears | One record, one copy, no query that could return a different title. The real claim was that other panels *see* it, which is F11 and E1. |
| R7, when two changes race the later one wins | Already covered by the existing unit test on staleness. If per-field last-write-wins ever lands, that unit test is what has to grow. |
| The action list as a surface on every R1 case | It filters by workspace, not by assignment, so only deletion changes what it returns. |
| Assigned twice does not duplicate | Moved into R6, where the rule actually lives. |
| Two panels with the same name keep separate assignments | Same claim as rename-keeps-assignments; both prove keying by id. |
| Turned the Inbox off again → hidden | Same setter as turning it on. |
| Right click in the Inbox, double click in the Inbox | Same component as on a panel. |
| An overlong title is truncated | That is CSS, and a test asserting it asserts a stylesheet. |
| Several hundred actions render and scroll | Performance, not correctness, and slow. Better looked at once by hand. |
| Whitespace-only title rejected | Only distinct if trimming is a rule. #33 trims panel names; nothing says so for action titles. Question for Part C. |

---

## Part C. What the issue does not answer

1. **What happens to an action when its panel is deleted?** #33 allows deleting a
   panel and #36 does not say. It is a missing case in R5.
2. **Does a completed action stay on the panel?** Whether it disappears, greys out,
   or moves.
3. **In what order do actions appear inside a panel?** Nothing says, and manual
   ordering would add both a model and a rule.
4. **Is deleting confirmed, and can a delete or a move be undone?**
5. **Can an action be created from the Inbox or the action list page?** That would
   add cases to F1.
6. **Can Assign to target several panels at once?** That would add a case to F5.
7. **Are the three recent targets remembered per workspace, per dashboard, or across
   everything?** This decides whether F5's recent-target cases are F1 or L2.
8. **Can an action be dragged onto the Inbox to unassign it?** A case in R1 and F6.
9. **Is archiving a third thing** next to delete and remove-from-panel?
10. **Are action titles trimmed?** Decides whether R8 gains a case.

---

## Counts

20 rules and about 35 cases: 7 backend rules, 11 frontend rules, 2 walks.

Where it came from: 47 flat statements, then 55 once split by claim, then 22 rules and
70 cases, then this. The rule count barely moved in the last pass; the case count
halved. The padding was inside the tables, not in the rules.
