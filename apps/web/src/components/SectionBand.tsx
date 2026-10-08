import { NAME_MAX_LENGTH } from '@cockpit/shared';
import { SurfaceMenu, SurfaceMenuButton, opensOnActivate, opensOnKey } from './Menu';

/**
 * A Section: a titled row of the board holding no Panels ("Add, rename and
 * delete a titled Section on a Dashboard", issue 896), drawn full width as a
 * band tinted in the Workspace's accent with its title in small uppercase
 * accent letters - no count and no box, since it holds nothing to count or
 * frame.
 *
 * **It is picked up by its band** ("Drag a Section between a Dashboard's rows",
 * issue 897), with a mouse's primary button as a Panel's header is, and placed
 * by the pointer's height alone (`panels/dragging.ts`).
 *
 * **Its menu is Rename and Delete only**, and Delete asks nothing: only a title
 * is lost, the stated exception to "Deleting anything asks first"
 * (docs/product/across-the-app.md). Renamed in place, as a Panel is.
 */
export function SectionBand({
  title,
  renaming,
  onRenamingChange,
  onStartRenaming,
  onRename,
  onStopRenaming,
  onDelete,
  refusal,
  busy,
  lifted,
  onPickUp,
}: {
  title: string;
  /** The title being typed while it is renamed, and null otherwise. */
  renaming: string | null;
  onRenamingChange: (title: string) => void;
  onStartRenaming: () => void;
  onRename: () => void;
  onStopRenaming: () => void;
  onDelete: () => void;
  /** Why the last change to this Section did not happen, if it did not. */
  refusal: string | null;
  busy: boolean;
  /** The band is in the air, being moved: drawn back and outlined in its slot, as a lifted Panel is. */
  lifted: boolean;
  /** Takes the band by hand, or null where nothing can be rearranged (filtered, a phone). */
  onPickUp: ((pointerId: number) => void) | null;
}) {
  const isRenaming = renaming !== null;
  return (
    <div className="min-w-0 pt-3">
      <SurfaceMenu
        label={`Actions for ${title}`}
        disabled={isRenaming}
        entries={
          isRenaming
            ? []
            : [
                { label: 'Rename', onSelect: onStartRenaming },
                { label: 'Delete', destructive: true, keepsFocus: true, onSelect: onDelete },
              ]
        }
      >
        <header
          tabIndex={isRenaming ? -1 : 0}
          onKeyDown={opensOnKey(isRenaming)}
          onClick={opensOnActivate(isRenaming)}
          // The guards a Panel's header has (`PanelCard`): a mouse's primary
          // button only, not while renaming or on the rename form's controls,
          // not on the menu's button, and only for a press that really landed
          // in this header - a menu entry is drawn in a portal but its event
          // bubbles through here.
          onPointerDown={(event) => {
            if (!onPickUp || isRenaming || event.button !== 0 || event.pointerType !== 'mouse') return;
            if ((event.target as Element).closest?.('button, input, form')) return;
            if (!event.currentTarget.contains(event.target as Node)) return;
            // Otherwise the browser starts a text selection across whatever the drag passes over.
            event.preventDefault();
            onPickUp(event.pointerId);
          }}
          role={isRenaming ? undefined : 'group'}
          aria-haspopup={isRenaming ? undefined : 'menu'}
          aria-label={isRenaming ? undefined : `Actions for ${title}`}
          // `group` and `relative` for the menu button, as a Panel's header
          // has them (`PanelCard`).
          className={`group relative flex min-h-10 items-center rounded-md bg-accent-tint px-3 py-2 pr-11 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
            lifted ? 'opacity-40 outline-2 outline-dashed outline-accent' : ''
          } ${isRenaming || !onPickUp ? '' : 'cursor-grab active:cursor-grabbing'}`}
        >
          {isRenaming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onRename();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onStopRenaming();
              }}
              className="flex min-w-0 flex-1 items-center gap-2"
            >
              <input
                value={renaming}
                onChange={(event) => onRenamingChange(event.target.value)}
                aria-label={`New title for ${title}`}
                maxLength={NAME_MAX_LENGTH}
                autoFocus
                className="min-w-0 flex-1 rounded-md border border-shade/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
              <button
                type="submit"
                disabled={busy}
                className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={onStopRenaming}
                className="shrink-0 rounded-md border border-shade/10 px-2 py-1 text-xs hover:bg-accent-tint hover:text-accent-deep"
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h3 className="min-w-0 truncate text-sm font-semibold uppercase tracking-[0.11em] text-accent-deep">
                {title}
              </h3>
              <SurfaceMenuButton
                label={`Actions for ${title}`}
                className="absolute top-1/2 right-2 -translate-y-1/2"
              />
            </>
          )}
        </header>
      </SurfaceMenu>
      {refusal && (
        <p role="alert" className="px-3 pt-1 text-xs text-over-ink">
          {refusal}
        </p>
      )}
    </div>
  );
}
