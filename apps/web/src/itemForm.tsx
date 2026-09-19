import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/**
 * Which Item's form is open, carried in the address (functional definition,
 * "Editing more than one field at a time happens in a form, and a form is a
 * modal with a route of its own").
 *
 * **A search parameter rather than a path.** The form opens over the Inbox,
 * over a dashboard and over the workspace alike, so a path of its own would
 * have to be nested under each of the three and the page underneath would stop
 * being the match that is rendered. Beside them, one address says both things:
 * where you were, and what is open over it.
 */
export interface ItemFormSearch {
  item?: string;
}

/**
 * What the address is allowed to carry of this. Anything else is dropped
 * rather than passed on, so a hand-typed `?item=` or a stale link cannot put a
 * value the form never expects into a query key.
 *
 * **The layout route is the only place a search parameter under the shell can
 * be declared at all**, so `router.tsx` composes this with every other one -
 * `connectionsSearch` today (`connections.ts`) - into its `validateSearch`.
 * A page that wants one of its own writes it beside what it belongs to and
 * joins it there, or it is silently dropped on the way in.
 */
export function itemFormSearch(search: Record<string, unknown>): ItemFormSearch {
  return typeof search.item === 'string' && search.item ? { item: search.item } : {};
}

/**
 * What a move between the views of one workspace - its dashboards and its
 * Inbox - carries over of the address: the open Item and nothing else ("Keep a
 * docked item open across dashboards in the same workspace", issue 482).
 *
 * **The Item is the workspace's, not the view's**, so it survives a change of
 * view and is left behind by a change of workspace, whose tabs name no search
 * at all. Only a docked form leaves the tabs pressable, a centered one being
 * modal, so this needs no word of which presentation is open.
 */
export function keepingTheOpenItem(was: ItemFormSearch): ItemFormSearch {
  return itemFormSearch(was as Record<string, unknown>);
}

/**
 * How a row asks for its Item's form.
 *
 * **A context rather than the router hook itself**, because the lists that draw
 * rows would otherwise each need a router around them to render at all - in
 * tests as much as in the app - to reach a fact that is really the shell's:
 * where a form is opened. The default opens nothing, so a list drawn outside
 * the shell is still a list.
 */
const OpenItem = createContext<(itemId: string) => void>(() => {});

export function useOpenItem(): (itemId: string) => void {
  return useContext(OpenItem);
}

/**
 * The Item shown in a docked form, if one is docked open - what a plain click
 * on a row follows ("Let a docked item's form follow the row you click", issue
 * 481). `openId` is null whenever nothing is docked open, which is what tells a
 * row that its plain click still opens nothing (issue 456).
 *
 * **A context, for the reason `OpenItem` is one**: rows are drawn outside the
 * router in tests, and only the shell knows both the address and whether the
 * form is really docked (a narrow screen renders a docked account's form
 * centered, `ItemForm.tsx`), so the form reports that fact up rather than the
 * row working it out.
 */
export interface DockedItem {
  openId: string | null;
  show: (itemId: string) => void;
}
const NO_DOCK: DockedItem = { openId: null, show: () => {} };
export const DockedItemContext = createContext<DockedItem>(NO_DOCK);
const ReportDocked = createContext<(docked: boolean) => void>(() => {});

export function useDockedItem(): DockedItem {
  return useContext(DockedItemContext);
}

/** How the form says it is really docked open, for as long as it is. */
export function useReportDocked(): (docked: boolean) => void {
  return useContext(ReportDocked);
}

/** The shell's answer: opening a form is a change of address. */
export function OpensItemForms({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ItemFormSearch;
  const [docked, setDocked] = useState(false);
  const open = useCallback(
    (itemId: string) => void navigate({ to: '.', search: (was) => ({ ...was, item: itemId }) }),
    [navigate],
  );
  // Replacing rather than pushing: following the rows is one open form
  // changing its Item, so Back leaves the page rather than stepping back
  // through every row that was looked at.
  const show = useCallback(
    (itemId: string) =>
      void navigate({ to: '.', replace: true, search: (was) => ({ ...was, item: itemId }) }),
    [navigate],
  );
  const dock = useMemo(
    () => ({ openId: docked ? (search.item ?? null) : null, show }),
    [docked, search.item, show],
  );
  return (
    <OpenItem.Provider value={open}>
      <ReportDocked.Provider value={setDocked}>
        <DockedItemContext.Provider value={dock}>{children}</DockedItemContext.Provider>
      </ReportDocked.Provider>
    </OpenItem.Provider>
  );
}

/**
 * What the form itself needs: which Item is open, and how to close it. Closing
 * is a change of address too, which is what makes the back button and Cancel
 * the same movement - neither has to be taught about the other.
 */
export function useItemForm(): { openItemId: string | undefined; close: () => void } {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ItemFormSearch;

  return {
    openItemId: search.item,
    close: () =>
      void navigate({
        to: '.',
        // Replacing rather than pushing, so closing collapses the entry opening
        // made instead of stacking a third on top of it. Pushing left
        // `[page] -> [page?item=x] -> [page]`, where Back after closing put the
        // form straight back up - the opposite of what the address is for.
        replace: true,
        search: (was) => {
          const { item: _closed, ...rest } = was as ItemFormSearch;
          return rest;
        },
      }),
  };
}
