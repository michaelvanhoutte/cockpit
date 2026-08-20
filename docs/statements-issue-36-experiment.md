# Statement list for issue #36 (experiment)

**Status:** experiment, not a decision. Generated from issue #36 to test whether
reviewing a generated statement list is worth the step. Delete when the experiment
is done.

## How to review

Mark each statement **keep**, **cut** or **change**. The measurement is what fraction
you touch. Under a fifth means the review step is not paying for itself and the
design changes.

Part A is intent, taken from the issue. Statements marked *(inferred)* are not in the
issue text; they follow from it. Those deserve the hardest look, because a wrong
inference becomes a test that enforces something you never said.

Part B is the failure axes, from a checklist rather than from the issue. Review these
for relevance, not for completeness.

Part C is what the issue does not answer. These need your call before the issue is
built, not before it is tested.

Levels are deliberately absent. Which level proves each statement is a separate open
question.

---

## Part A. Intent, from the issue

### action.create
1. An action created from a panel appears on that panel.
2. An action created with the dashboard's add button appears in the Inbox and on no panel.
3. A panel shows an action's short title, not its description.

### action.edit
4. Double clicking an action in a panel opens it for editing.
5. Editing an action's title changes what every panel showing it displays.

### action.complete
6. Completing an action on one panel shows it as completed on every other panel showing it, without a reload.

### action.delete
7. Deleting an action removes it from every panel at once.
8. Deleting an action removes it from the workspace's action list. *(inferred)*

### action.remove-from-panel
9. Removing an action from a panel leaves it on the other panels it is assigned to.
10. Removing an action from a panel does not delete it.
11. Removing an action from its only panel returns it to the Inbox. *(inferred)*

### action.assign
12. Assigning an action to a panel takes it out of the Inbox.
13. An action assigned to two panels appears on both.
14. Right clicking an action offers Assign to, which shows a tree of the dashboards and their panels.
15. The Assign to modal shows the three most recently used target panels above the tree.
16. Assigning to a panel makes it the most recent target. *(inferred)*
17. Right clicking an action in the Inbox offers the same Assign to as right clicking one on a panel.
18. An action can be assigned to panels on different dashboards at the same time. *(inferred)*

### action.move
19. Dropping an action on a different panel asks whether to move it, or to add it while keeping it on the source.
20. Choosing move takes the action off the source panel and puts it on the target.
21. Choosing add leaves the action on the source panel and also puts it on the target.
22. Dragging an action over another dashboard's name switches to that dashboard, so it can be dropped on a panel there.

### panel.inbox
23. The Inbox shows every action in the workspace that is on no panel.
24. The Inbox cannot be renamed.
25. The Inbox cannot be deleted.
26. The Inbox's visibility can be toggled on each dashboard.
27. The Inbox is hidden by default on every dashboard.
28. Toggling the Inbox on one dashboard does not show it on another. *(inferred)*

### panel.assignment
29. Renaming a panel keeps the actions assigned to it.
30. Panels with the same name on different dashboards keep separate assignments. *(inferred)*

### action.list
31. A workspace has a page listing all its actions as a plain table, with no panels.
32. The action list includes actions in the Inbox as well as actions on panels. *(inferred)*

---

## Part B. Failure axes, from the checklist

### Concurrent use
33. The same action edited in two open tabs ends on the last edit, not on a mix of both.
34. An action completed in one tab shows as completed in another without a reload.

### Repeat and retry
35. Dropping an action back on the panel it came from changes nothing.
36. Assigning an action to a panel it is already on changes nothing and does not duplicate it.
37. Deleting an action that is already deleted does not error.

### Isolation
38. An action never appears on a panel in another workspace.
39. One workspace's Inbox never shows another workspace's actions.

### Empty and large
40. A panel with no actions renders as an empty panel.
41. The Inbox with no actions renders as empty rather than disappearing.
42. A panel holding several hundred actions still renders and scrolls.
43. The Assign to tree renders when the workspace has no other dashboards or panels yet.

### Partial failure
44. An assignment that fails leaves the action on its original panel, not on neither.
45. A delete that fails leaves the action visible rather than half removed.

### Input
46. An action cannot be saved without a title.
47. A title long enough to overflow the panel is truncated rather than breaking the layout.

---

## Part C. What the issue does not answer

1. **What happens to an action when its panel is deleted?** #33 allows deleting a
   panel and #36 does not say. Returning it to the Inbox unless it is on another
   panel is the obvious answer, but it is not written anywhere.
2. **Does a completed action stay on the panel?** #36 says completion propagates,
   not whether the action disappears, greys out, or moves.
3. **In what order do actions appear inside a panel?** Nothing says. Manual
   ordering, creation order, or something else changes both the model and the UI.
4. **Is deleting confirmed, and can a delete or a move be undone?**
5. **Can an action be created from the Inbox or from the action list page**, or only
   from a panel and the dashboard button?
6. **Can the Assign to modal assign to several panels at once?**
7. **Are the three recent targets remembered per workspace, per dashboard, or across
   everything?**
8. **Can an action be dragged onto the Inbox to unassign it?**

---

## Counts

47 statements, 32 from the issue and 15 from the failure checklist. 8 statements are
inferences rather than stated. 8 questions the issue does not answer.
