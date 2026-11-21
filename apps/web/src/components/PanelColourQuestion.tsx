import * as Dialog from '@radix-ui/react-dialog';
import { SWATCHES, type Swatch } from '@cockpit/shared/board';
import { swatchInk, swatchLabel, swatchTint } from '../panelColour';

/**
 * A Panel's colour, picked from the eight swatches or *None* ("Brainstorming:
 * Panels can't be told apart at a glance", issue 1832). A choice is the answer:
 * it is sent and the question closes, with no Save to press after it.
 *
 * Lazy-loaded from `PanelBoard.tsx`, for the reason `SortQuestion` is.
 */
function PanelColourQuestion({
  panelName,
  colour,
  open,
  onPick,
  onCancel,
  returnFocusTo,
}: {
  panelName: string;
  /** What the Panel is now, or null for None. */
  colour: Swatch | null;
  open: boolean;
  onPick: (colour: Swatch | null) => void;
  onCancel: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">Colour of {panelName}</Dialog.Title>
          <Dialog.Description className="pt-2 text-sm text-ink-soft">
            Drawn on its header and border in the lists.
          </Dialog.Description>
          <div className="flex flex-wrap items-center gap-2 pt-4" role="radiogroup" aria-label="Colour">
            {SWATCHES.map((one) => (
              <button
                key={one}
                type="button"
                role="radio"
                aria-checked={colour === one}
                aria-label={swatchLabel(one)}
                title={swatchLabel(one)}
                onClick={() => onPick(one)}
                className={`size-7 rounded-full border-2 ${colour === one ? 'ring-2 ring-accent ring-offset-2' : ''}`}
                style={{ background: swatchTint(one), borderColor: swatchInk(one) }}
              />
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={colour === null}
              onClick={() => onPick(null)}
              className={`rounded-full border border-shade/20 px-3 py-1 text-sm text-ink-soft ${colour === null ? 'ring-2 ring-accent ring-offset-2' : ''}`}
            >
              None
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default PanelColourQuestion;
