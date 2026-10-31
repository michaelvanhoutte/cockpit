import { itemLabel, itemStatus } from '@cockpit/shared';
import { STATUS_LABELS } from '../allItems';
import type { SplitRelations } from '../splitOff';

/**
 * The lines under an Item's title naming the Item it was split off from, and
 * each Item split off it with its status (`splitOff.ts`). Each name opens that
 * Item's form. Nothing for an Item with neither.
 */
export function SplitLines({ relations, onOpen }: { relations: SplitRelations; onOpen: (itemId: string) => void }) {
  const { from, off } = relations;
  if (!from && off.length === 0) return null;
  const link = 'font-semibold text-accent-deep underline';
  return (
    <div className="mt-2 shrink-0 space-y-0.5 break-words text-xs text-ink-faint" data-split-lines>
      {from && (
        <p>
          Split off from{' '}
          <button type="button" onClick={() => onOpen(from.id)} className={link}>
            {itemLabel(from)} ›
          </button>
        </p>
      )}
      {off.map((other) => (
        <p key={other.id}>
          Split off to{' '}
          <button type="button" onClick={() => onOpen(other.id)} className={link}>
            {itemLabel(other)} ›
          </button>{' '}
          <span className="text-ink-soft">· {STATUS_LABELS[itemStatus(other)]}</span>
        </p>
      ))}
    </div>
  );
}
