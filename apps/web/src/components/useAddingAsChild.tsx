import { Suspense, lazy, useState } from 'react';
import type { Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { useUndo } from '../undo';

/** Fetched only once *Add as child of…* is asked, as the other windows opened from a row are. */
const AddAsChildOf = lazy(() => import('./AddAsChildOf'));
/** What adding sends and offers, in the same chunk as the picker, which is loaded by the time Add is pressed. */
const addAsChildren: typeof import('./AddAsChildOf').addAsChildren = (...args) => {
  void import('./AddAsChildOf').then((loaded) => loaded.addAsChildren(...args));
};

/**
 * *Add as child of…* from a row's menu or a selection's bar ("Brainstorming: an
 * Item can't hold other Items", issue 1825): asks which Item, puts the chosen
 * ones inside it, and offers Undo, which takes out the ones it put in. One
 * already inside that parent stays, and Undo leaves it there.
 */
export function useAddingAsChild(workspaceId: string, afterAdding?: () => void) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const [asking, setAsking] = useState<readonly Item[] | null>(null);
  /** The menu button it was asked from, which the focus goes back to. */
  const [askedFrom, setAskedFrom] = useState<HTMLElement | null>(null);

  const dialog = asking && data && (
    <Suspense fallback={null}>
      <AddAsChildOf
        chosen={asking}
        items={data.items}
        children={data.children ?? []}
        onAdd={(parent) => {
          setAsking(null);
          afterAdding?.();
          addAsChildren({ workspaceId, send, offerToUndo, children: data.children ?? [] }, asking, parent);
        }}
        onClose={() => setAsking(null)}
        returnFocusTo={askedFrom}
      />
    </Suspense>
  );

  return {
    ask: (chosen: readonly Item[], from: HTMLElement | null = null) => {
      setAskedFrom(from);
      setAsking(chosen);
    },
    dialog,
  };
}
