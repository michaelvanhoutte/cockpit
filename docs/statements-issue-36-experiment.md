# Statement list for issue #36 (experiment)

**Status:** experiment, not a decision. Delete when the experiment is done.

## How to review

Each item is a **rule** in product language, with the **cases** that exercise it. One
rule is one test body; the cases are a table inside it, one line each. What the
runner prints for each case is a plain-English statement, and those printed lines are
the statement list. Nothing separate is stored.

Mark each rule and each case **keep**, **cut** or **change**. The measurement is what
fraction you touch.

Levels are `docs/testing-strategy.md`'s: L2 integration (the API in process against a
real local database), F1 frontend unit, F2 frontend plus its own backend, F3 end to
end.

*(inferred)* marks a case that is not in the issue text but follows from it. Those
deserve the hardest look.

---

## Backend rules

### R1 `L2` A panel shows exactly the actions assigned to it, and the Inbox exactly the ones assigned to no panel

Checked against five places every time: panel A, panel B on the same dashboard,
panel C on another dashboard, the Inbox, and the action list page.

- created on panel A → on A only
- created with the dashboard's add button → in the Inbox only
- assigned to A from the Inbox → on A only
- assigned to B as well → on A and B
- assigned to C on another dashboard → on A and C *(inferred)*
- assigned to A a second time → on A once, not twice
- moved from A to B → on B only
- added to B while kept on A → on A and B
- removed from B while also on A → on A only
- removed from A, its only panel → in the Inbox *(inferred)*
- deleted → nowhere, including the action list *(inferred)*
- created in another workspace → nowhere in this one

### R2 `L2` A change to an action is visible everywhere the action appears

Checked on panel A, panel B (both holding the action) and the action list.

- completed → shown as completed in all three
- title changed → the new title in all three
- description changed → the new description where the description is shown

### R3 `L2` The Inbox is fixed and cannot be renamed or deleted

- a rename of the Inbox → rejected, the Inbox is unchanged
- a delete of the Inbox → rejected, the Inbox is still there

### R4 `L2` Showing the Inbox is a per-dashboard setting, off by default

- a newly created dashboard → the Inbox is hidden
- turned on for dashboard 1 → shown on 1, still hidden on 2 *(inferred)*
- turned off again → hidden on 1

### R5 `L2` Assignments belong to the panel, not to its name

- panel A renamed → the same actions are still on it
- two panels with the same name on different dashboards → separate contents *(inferred)*
- panel A deleted → **open question 1**, the issue does not say

### R6 `L2` Sending the same command twice changes nothing the second time

- the same create sent twice → one action
- the same assign sent twice → assigned once
- the same delete sent twice → deleted, no error
- an action dropped back on the panel it came from → unchanged

### R7 `L2` When two changes race, the later one wins

- two edits sent in order → the second one stands
- an edit that arrives after a newer one → ignored, the newer value stands

### R8 `L2` An invalid command is rejected and changes nothing

This table grows with every rule added later, and no test is added when it does.

- create with no title → rejected
- create with a whitespace-only title → rejected
- assign to a panel that does not exist → rejected
- any rejected command → nothing changed in the database

### R9 `L2` A workspace never sees another workspace's data

Checked on every read: panel contents, the Inbox, the action list, a single action
fetched by id.

- an action in another workspace → absent from all four
- a panel in another workspace → absent

---

## Frontend rules

### F1 `F1` Every place that creates an action sends the right create

- a panel's add button → a create for that panel
- the dashboard's add button → a create with no panel

### F2 `F1` The action editor opens where the issue says it does

- double click on an action in a panel → the editor opens
- double click on an action in the Inbox → the editor opens *(inferred)*

### F3 `F1` A panel renders an action as its short title

- a normal action → the title, and not the description
- a title too long for the panel → truncated, the layout holds

### F4 `F1` A panel renders sensibly when empty or very full

Checked for a normal panel and for the Inbox.

- no actions → an empty panel, still visible
- several hundred actions → renders and scrolls

### F5 `F1` Assign to offers every panel, with the recent ones first

- right click on a panel → the modal opens with a tree of dashboards and panels
- right click in the Inbox → the same modal
- the workspace has no other dashboards or panels → the tree still renders
- after assigning → that panel is first in the recent list *(inferred; see question 7)*
- after four assignments → three recent targets shown, the oldest dropped *(inferred)*

### F6 `F1` Dropping an action on another panel asks, then sends what was chosen

- choose move → a move is sent
- choose add → an add is sent
- cancel → nothing is sent
- dropped on the panel it came from → nothing is sent, no prompt *(inferred)*

### F7 `F1` Dragging over another dashboard's name switches to it

- dragging over another dashboard's name → that dashboard opens
- dragging over the current dashboard's name → nothing happens *(inferred)*

### F8 `F1` A command that fails leaves the screen as it was

This table grows with every command, and no test is added when it does.

- an assign that fails → the action is still on its original panel
- a delete that fails → the action is still visible
- an edit that fails → the old values are back

### F9 `F1` A rejected command shows the error the backend returned

One case covers every validation rule, now and later.

- a create rejected for a missing title → the form shows that error

### F10 `F1` The action list page shows all actions as a plain table

- actions on panels and in the Inbox → all listed, no panels rendered
- no actions → an empty table, not a broken page

### F11 `F2` Open panels refresh when the server signals a change

- a change to an action shown on an open panel → the panel reloads
- a change to an action not shown → no visible change

---

## End to end

### E1 `F3` The core loop works in a real browser

Create an action from the dashboard button, assign it to a panel with Assign to,
watch it leave the Inbox, complete it, and see it completed on a second panel that
also holds it.

### E2 `F3` Drag and drop works in a real browser

Drag an action from one panel to another, choose move, and see it on the target and
gone from the source.

---

## Part C. What the issue does not answer

1. **What happens to an action when its panel is deleted?** #33 allows deleting a
   panel and #36 does not say. This is a missing case in R5.
2. **Does a completed action stay on the panel?** R2 proves the change propagates,
   not what it looks like.
3. **In what order do actions appear inside a panel?** Nothing says. Manual ordering
   versus creation order changes both the model and the UI, and it would add a rule.
4. **Is deleting confirmed, and can a delete or a move be undone?**
5. **Can an action be created from the Inbox or the action list page?** That would
   add cases to F1.
6. **Can Assign to target several panels at once?** That would add a case to F5.
7. **Are the three recent targets remembered per workspace, per dashboard, or across
   everything?** This decides whether F5's recent-target cases are F1 or L2.
8. **Can an action be dragged onto the Inbox to unassign it?** That would add a case
   to R1 and F6.
9. **Is archiving a third thing** next to delete and remove-from-panel?

---

## Counts

22 rules: 9 backend, 11 frontend, 2 end to end. Around 70 cases, and the cases produce
roughly 120 printed statements once the multi-surface rules are expanded.

Previous version: 55 flat statements, no rules.

What the rewrite changed:

- Fifteen of the old statements collapsed into R1, which says the actual rule rather
  than fifteen consequences of it.
- Idempotency, validation and workspace isolation became rules whose tables grow as
  the product grows, so adding a validation rule later adds a line, not a test.
- Two of the three end-to-end tests survived; the third was a restatement of R2.
- Two questions moved from Part C into the rules as missing cases, which is where
  they are visible.
