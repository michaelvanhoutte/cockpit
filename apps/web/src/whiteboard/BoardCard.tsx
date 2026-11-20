import type { HTMLAttributes, ReactNode } from 'react';
import { asNextAction, doneOfHeld, holdsItems, itemLabel, itemStatus, type Item } from '@cockpit/shared';
import { DEADLINE_PILLS, deadlineOf } from '../dueDate';
import { capturingApp, sourceOnARow, type SourceNames } from '../itemSource';
import { PRIORITY_FLAG_COLOURS, PRIORITY_LABELS } from '../priority';
import { CARD_W } from './layout';

const STATUS_WORDS = { to_do: null, in_progress: 'In progress', waiting: 'Waiting', done: 'Done' } as const;

/**
 * A card on a whiteboard ("Brainstorming: give every Dashboard a whiteboard of
 * its own", issue 1829): the Item's row in a card's width - its flag, title,
 * status, *Next:*, due pill and source line, from the row's own fields and
 * helpers so the two never say different things - with ⋮ on hover for the
 * Item's one menu. A finished Item keeps its card, drawn done.
 *
 * **A parent's card unfolds to its children** in a grid inside it, in their own
 * order; they are not placed, and each is drawn as a card of its own.
 */
export function BoardCard({
  item,
  sourceNames,
  now,
  children = [],
  unfolded = false,
  onUnfold,
  onMenu,
  onOpenChild,
  nested = false,
  renaming = null,
  titleProps,
}: {
  item: Item;
  sourceNames: SourceNames | undefined;
  /** The clock the due pill is read against. */
  now: number;
  /** A parent's children, in their own order: what it unfolds to. */
  children?: readonly Item[];
  unfolded?: boolean;
  onUnfold?: () => void;
  /** ⋮ pressed: the Item's menu, at the press. */
  onMenu?: (at: { x: number; y: number }) => void;
  /** A child card double-clicked: that child opened. */
  onOpenChild?: (itemId: string) => void;
  /** Drawn inside a parent's card, which has no ⋮ or unfolding of its own. */
  nested?: boolean;
  /** The field the title is typed in while it is renamed in place, drawn in the title's place (issue 1830). */
  renaming?: ReactNode;
  /** What the board listens for on the title: a click on a selected card's title renames it. */
  titleProps?: HTMLAttributes<HTMLSpanElement> | undefined;
}) {
  const status = itemStatus(item);
  const done = status === 'done';
  const label = itemLabel(item);
  const nextAction = asNextAction(item.nextAction);
  const deadline = done ? null : deadlineOf(item.dueDate, now);
  const holds = holdsItems(item);
  const statusWord = STATUS_WORDS[status];
  return (
    <div
      data-card={label}
      data-done={done ? '' : undefined}
      className={`group/card flex flex-col gap-0.5 rounded-md border border-shade/10 bg-field px-2.5 py-1.5 text-left shadow-panel ${done ? 'opacity-60' : ''}`}
      style={{ width: nested ? undefined : CARD_W }}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <Flag priority={item.priority} />
        {holds && !nested && (
          <button
            type="button"
            aria-label={unfolded ? `Fold ${label}` : `Unfold ${label}`}
            aria-expanded={unfolded}
            onClick={(event) => {
              event.stopPropagation();
              onUnfold?.();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className="nodrag flex size-4 shrink-0 items-center justify-center rounded text-xs text-ink-soft hover:bg-accent-tint"
          >
            {unfolded ? '▾' : '▸'}
          </button>
        )}
        {renaming ?? (
          <span {...titleProps} className={`line-clamp-2 min-w-0 flex-1 text-[13px] leading-tight font-medium ${done ? 'text-ink-faint line-through' : 'text-ink-strong'}`}>
            {label}
          </span>
        )}
        {onMenu && !nested && (
          <button
            type="button"
            aria-label={`Actions for ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              onMenu({ x: event.clientX, y: event.clientY });
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className="nodrag -mr-1 flex size-5 shrink-0 items-center justify-center rounded text-ink-soft opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 hover:bg-accent-tint"
          >
            ⋮
          </button>
        )}
      </div>
      {nextAction && (
        <span className="truncate text-xs text-ink">
          <span className="font-semibold text-accent-deep">Next:</span> {nextAction}
        </span>
      )}
      <span className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-ink-faint">
        {statusWord && <span className="shrink-0 rounded-full bg-accent-tint px-1.5 text-accent-deep">{statusWord}</span>}
        {deadline && <span className={`shrink-0 rounded-full px-1.5 font-medium ${DEADLINE_PILLS[deadline.level]}`}>{deadline.label}</span>}
        {holds && <span className="shrink-0">{doneOfHeld(item)}</span>}
        <span className="truncate">
          {sourceOnARow(item, sourceNames ?? {})}
          {item.sender && !capturingApp(item) ? ` · ${item.sender}` : ''}
        </span>
      </span>
      {holds && unfolded && !nested && (
        <ul aria-label={`Inside ${label}`} className="mt-1 grid grid-cols-2 gap-1.5">
          {children.map((child) => (
            <li
              key={child.id}
              onDoubleClick={(event) => {
                if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
                event.stopPropagation();
                onOpenChild?.(child.id);
              }}
            >
              <BoardCard item={child} sourceNames={sourceNames} now={now} nested />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The priority flag the row leads with: named where there is a level, a faint decoration where there is none. */
function Flag({ priority }: { priority: Item['priority'] }) {
  if (!priority) {
    return (
      <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-shade/5 text-[9px] leading-none text-shade/15">
        ⚑
      </span>
    );
  }
  const name = `${PRIORITY_LABELS[priority]} priority`;
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] leading-none text-white ${PRIORITY_FLAG_COLOURS[priority]}`}
    >
      ⚑
    </span>
  );
}
