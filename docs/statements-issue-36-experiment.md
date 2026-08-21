# Statement list for issue #36 (experiment)

**Status:** experiment, not a decision. Generated from issue #36 to test whether
reviewing a generated statement list is worth the step. Delete when the experiment
is done.

## How to review

Mark each statement **keep**, **cut** or **change**. The measurement is what fraction
you touch. Under a fifth means the review step is not paying for itself.

Also check the **level** and its reason. Reasons are given where the level is a
judgment; where it is obvious the statement stands alone. Levels are
`docs/testing-strategy.md`'s: L1 unit, L2 integration, L3 system, F1 frontend unit,
F2 frontend plus its own backend, F3 end to end.

*(inferred)* means the statement is not in the issue text, it follows from it. Those
deserve the hardest look, because a wrong inference becomes a test enforcing
something you never said.

Part C is what the issue does not answer. Those need your call before it is built,
not before it is tested.

---

## action.create

1. `L2` An action created with a panel assignment comes back in that panel's contents. *(a panel's contents are a query, so this only holds against a real database)*
2. `L2` An action created with no panel assignment comes back in the Inbox and on no panel.
3. `L2` An action cannot be created without a title. *(the rule lives at the write boundary)*
4. `F1` A panel's add button creates an action for that panel.
5. `F1` The dashboard's add button creates an action with no panel.
6. `F1` A create form shows the error the backend returns. *(one statement covering every validation rule, now and later)*

## action.edit

7. `L2` An edited action's new values come back everywhere it appears.
8. `F1` Double clicking an action in a panel opens it for editing.
9. `F1` A panel shows an action's short title, not its description.
10. `F1` A panel re-renders an action when new contents arrive.
11. `F2` When the server signals a change, open panels reload their contents. *(needs the real event stream to mean anything)*

## action.complete

12. `L2` A completed action comes back as completed in every panel that holds it.
13. `F3` Completing an action on one panel shows it completed on another panel without a reload. *(only true when the stream, the client cache and two panels are all real)*

## action.delete

14. `L2` Deleting an action removes it from every panel at once.
15. `L2` Deleting an action removes it from the workspace's action list. *(inferred)*
16. `L2` Deleting an action that is already deleted does not error.
17. `F1` A delete that fails leaves the action visible rather than half removed. *(the optimistic update has to roll back)*

## action.remove-from-panel

18. `L2` Removing an action from a panel leaves it on the other panels it is on.
19. `L2` Removing an action from a panel does not delete it.
20. `L2` Removing an action from its only panel returns it to the Inbox. *(inferred)*

## action.assign

21. `L2` Assigning an action to a panel takes it out of the Inbox.
22. `L2` An action assigned to two panels comes back in both.
23. `L2` An action can be assigned to panels on different dashboards at the same time. *(inferred)*
24. `L2` Assigning an action to a panel it is already on does not duplicate it.
25. `F1` Right clicking an action offers Assign to, showing a tree of the dashboards and their panels.
26. `F1` The Assign to modal shows the three most recently used target panels above the tree.
27. `F1` Assigning to a panel makes it the most recent target. *(inferred; the level depends on question 7)*
28. `F1` Right clicking an action in the Inbox offers the same Assign to as on any panel.
29. `F1` The Assign to tree renders when the workspace has no other dashboards or panels.
30. `F1` An assignment that fails leaves the action on its original panel, not on neither.

## action.move

31. `L2` Moving an action between panels leaves it on the target only.
32. `L2` Dropping an action back on the panel it came from changes nothing.
33. `F1` Dropping an action on a different panel asks whether to move it or to add it.
34. `F1` Choosing move sends a move, choosing add sends an add.
35. `F1` Dragging an action over another dashboard's name switches to that dashboard.
36. `F3` An action dragged to another panel and moved shows on the target and not the source. *(the drag only exists in a browser)*

## panel.inbox

37. `L2` The Inbox contains every action in the workspace that is on no panel.
38. `L2` A request to rename the Inbox is rejected.
39. `L2` A request to delete the Inbox is rejected.
40. `L2` The Inbox is hidden by default on every dashboard.
41. `L2` Showing the Inbox on one dashboard does not show it on another. *(inferred)*
42. `F1` The Inbox panel offers no rename or delete.
43. `F1` A dashboard has a control that toggles the Inbox.
44. `F1` The Inbox with no actions renders as empty rather than disappearing.

## panel.assignment

45. `L2` Renaming a panel keeps the actions assigned to it.
46. `L2` Panels with the same name on different dashboards keep separate assignments. *(inferred)*
47. `F1` A panel with no actions renders as an empty panel.
48. `F1` A panel holding several hundred actions renders and scrolls.
49. `F1` A title too long for the panel is truncated rather than breaking the layout.

## action.list

50. `L2` The action list contains every action in the workspace, on a panel or in the Inbox. *(inferred)*
51. `F1` The workspace has a page showing all its actions as a plain table, with no panels.

## isolation and convergence

52. `L2` An action never comes back in another workspace's panel contents.
53. `L2` One workspace's Inbox never contains another workspace's actions.
54. `L2` Two edits to the same action land on the later one, not a mix of both.

## the capability walk

55. `F3` An action created in the Inbox, then assigned to a panel, shows on that panel and leaves the Inbox.

---

## Part C. What the issue does not answer

1. **What happens to an action when its panel is deleted?** #33 allows deleting a
   panel and #36 does not say. Returning it to the Inbox unless it is on another
   panel is the obvious answer, but it is written nowhere.
2. **Does a completed action stay on the panel?** #36 says completion propagates,
   not whether the action disappears, greys out, or moves.
3. **In what order do actions appear inside a panel?** Nothing says. Manual ordering
   versus creation order changes both the model and the UI.
4. **Is deleting confirmed, and can a delete or a move be undone?**
5. **Can an action be created from the Inbox or from the action list page**, or only
   from a panel and the dashboard button?
6. **Can the Assign to modal assign to several panels at once?**
7. **Are the three recent targets remembered per workspace, per dashboard, or across
   everything?** This decides whether statement 27 is F1 or L2.
8. **Can an action be dragged onto the Inbox to unassign it?**
9. **Is archiving a third thing** next to delete and remove-from-panel? The issue has
   only the latter two.

---

## Counts and what changed

55 statements, up from 47.

| Level | Count |
|---|---|
| L1 | 0 |
| L2 | 28 |
| F1 | 23 |
| F2 | 1 |
| F3 | 3 |

Changed from the first version:

- Six statements carried both a state claim and a UI claim and became two each.
- Two merged. "Choosing add leaves it on both" has the same backend half as "assigned
  to two panels appears on both". "Completed in one tab shows in another" is the
  completion walk.
- One added: the create form shows the error the backend returns, which covers every
  validation rule rather than one per rule.

Two things worth arguing about:

- **No L1 statements at all.** Either that confirms unit tests have little to prove
  here, since almost everything is state across a real database, or the design has no
  pure core worth testing and that is itself a finding.
- **Three F3 walks across eight capabilities.** Testing-strategy §5.1 asks for a
  frontend test per capability, and F2 counts where F3 cannot reach. Either several
  F1s become F2s, or the walk count grows, or §5.1 gets read more loosely.
