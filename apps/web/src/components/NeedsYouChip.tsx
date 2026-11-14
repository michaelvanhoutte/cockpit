import { Suspense, lazy, useRef, useState } from 'react';
import type { NeedsYouBox } from '../agentRunChip';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';

/**
 * A *Needs you* chip with no session to open (issue 1770): a click opens a small
 * box saying what Claude is asking and where to answer it, with *End Claude run*.
 * Drawn from the run the held copy already carries, so it reaches no server. The
 * box is loaded on the first click (`NeedsYouPopover`), keeping the popover
 * library out of the first load.
 */

const NeedsYouPopover = lazy(() => import('./NeedsYouPopover').then((loaded) => ({ default: loaded.NeedsYouPopover })));

export function NeedsYouChip({
  box,
  label,
  className,
  onEnd,
  onLoadFailure,
}: {
  box: NeedsYouBox;
  /** What the chip itself says. */
  label: string;
  className: string;
  /** *End Claude run*, chosen in the box. */
  onEnd: () => void;
  /** The box's chunk did not arrive. */
  onLoadFailure: () => void;
}) {
  const chip = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={chip}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Opens only: a press outside the box, the chip's own included, closes it.
        onClick={() => setOpen(true)}
        // A control of the row's own, so a right-click on it is not the row's menu.
        onContextMenu={(event) => event.stopPropagation()}
        className={`${className} cursor-pointer`}
      >
        {label}
      </button>
      {open && (
        <WhateverTheQuestionDoes
          onFailure={() => {
            setOpen(false);
            onLoadFailure();
          }}
        >
          <Suspense fallback={null}>
            <NeedsYouPopover anchor={chip} box={box} onEnd={onEnd} onClose={() => setOpen(false)} />
          </Suspense>
        </WhateverTheQuestionDoes>
      )}
    </>
  );
}
