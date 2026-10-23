import { itemLabel, type Item } from '@cockpit/shared';
import { dateTimeLabel } from '../dateFormat';
import { firstLineOf } from '../duplicates';
import { sourceOnARow, type SourceNames } from '../itemSource';

/**
 * One note on the duplicate warning: enough of it to tell it from the other (its
 * title, where it came from and when, the first line of what it says), and the
 * button that keeps it ("Choose which of two possible duplicates to keep, from
 * the warning", issue 1451).
 *
 * **Where it came from is said as the row says it** (`sourceOnARow`), and the
 * description's first line without its Markdown, since two notes captured from
 * the same words have the same title and little else to tell them by.
 */
function NoteCard({
  note,
  heading,
  open,
  sourceNames,
  disabled,
  onKeep,
  onOpen,
}: {
  note: Item;
  heading: string;
  /** The note whose form this is, outlined so the person can see which one they are on. */
  open: boolean;
  sourceNames: SourceNames;
  disabled: boolean;
  onKeep: () => void;
  /** Present only on the other note's card: this note's form is already open. */
  onOpen?: () => void;
}) {
  const firstLine = firstLineOf(note.description);
  return (
    <div
      role="group"
      aria-label={heading}
      className={`flex flex-col gap-1 rounded-md border bg-surface px-3 py-2 text-sm ${open ? 'border-accent' : 'border-shade/10'}`}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{heading}</span>
      <span className="break-words font-medium text-ink">{itemLabel(note)}</span>
      <span className="text-xs text-ink-faint">
        {sourceOnARow(note, sourceNames)} · {dateTimeLabel(note.createdAt)}
      </span>
      <span className="line-clamp-2 break-words text-xs text-ink-soft">{firstLine ?? <em>No description</em>}</span>
      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
        <button
          type="button"
          disabled={disabled}
          onClick={onKeep}
          className="rounded-md border border-shade/10 bg-surface px-2 py-1 text-sm font-medium text-ink hover:border-accent hover:bg-accent-tint disabled:opacity-50"
        >
          Keep this one
        </button>
        {onOpen && (
          <button
            type="button"
            disabled={disabled}
            onClick={onOpen}
            className="text-xs text-accent hover:underline disabled:opacity-50"
          >
            Open
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The question a possible duplicate asks, for one pair: which of the two notes
 * to keep. This note on one side, the other on the other (stacked on a phone,
 * this one first), and under them the answer that keeps both.
 *
 * Offered rather than acted on: nothing here merges or files anything, and what
 * each button does is the form's to say.
 */
export function KeepWhichNote({
  thisNote,
  other,
  sourceNames,
  disabled,
  onKeepThis,
  onKeepOther,
  onOpenOther,
  onKeepBoth,
}: {
  thisNote: Item;
  other: Item;
  sourceNames: SourceNames;
  disabled: boolean;
  onKeepThis: () => void;
  onKeepOther: () => void;
  onOpenOther: () => void;
  onKeepBoth: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
        <NoteCard
          note={thisNote}
          heading="This note (open)"
          open
          sourceNames={sourceNames}
          disabled={disabled}
          onKeep={onKeepThis}
        />
        <NoteCard
          note={other}
          heading="The other note"
          open={false}
          sourceNames={sourceNames}
          disabled={disabled}
          onKeep={onKeepOther}
          onOpen={onOpenOther}
        />
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onKeepBoth}
        className="self-start rounded-md border border-shade/10 bg-surface px-2 py-1 text-sm text-ink hover:border-accent hover:bg-accent-tint disabled:opacity-50"
      >
        Keep both: not a duplicate
      </button>
    </div>
  );
}
