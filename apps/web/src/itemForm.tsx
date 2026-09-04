import { createContext, useCallback, useContext, type ReactNode } from 'react';
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
 * What the address is allowed to carry. Anything else is dropped rather than
 * passed on, so a hand-typed `?item=` or a stale link cannot put a value the
 * form never expects into a query key.
 */
export function itemFormSearch(search: Record<string, unknown>): ItemFormSearch {
  return typeof search.item === 'string' && search.item ? { item: search.item } : {};
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

/** The shell's answer: opening a form is a change of address. */
export function OpensItemForms({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const open = useCallback(
    (itemId: string) => void navigate({ to: '.', search: (was) => ({ ...was, item: itemId }) }),
    [navigate],
  );
  return <OpenItem.Provider value={open}>{children}</OpenItem.Provider>;
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
        search: (was) => {
          const { item: _closed, ...rest } = was as ItemFormSearch;
          return rest;
        },
      }),
  };
}
