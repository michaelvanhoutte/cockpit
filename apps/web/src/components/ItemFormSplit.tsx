import type { Item } from '@cockpit/shared';
import { useAddingAsChild } from './useAddingAsChild';

/**
 * *Split…* on an Item's form ("Brainstorming: a note holding several ideas
 * can't be taken apart", issue 1828), under the words it takes apart. In a chunk
 * of its own fetched with the form, so none of it is in the initial bundle.
 *
 * Disabled while what is typed is not yet written: it is not what the window
 * would read. The form is closed once the Item is split, as it holds the words
 * from before.
 */
export default function ItemFormSplit({
  workspaceId,
  item,
  unwritten,
  onSplit,
  buttonClass,
}: {
  workspaceId: string;
  item: Item;
  unwritten: boolean;
  onSplit: () => void;
  buttonClass: string;
}) {
  const splitting = useAddingAsChild(workspaceId);
  return (
    <div className="flex shrink-0 justify-end pt-1">
      <button
        type="button"
        disabled={unwritten}
        title={unwritten ? 'Save your changes first' : undefined}
        onClick={(event) => splitting.split(item.id, event.currentTarget, onSplit)}
        className={buttonClass}
      >
        Split…
      </button>
      {splitting.dialog}
    </div>
  );
}
