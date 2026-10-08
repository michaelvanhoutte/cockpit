import { Suspense, lazy } from 'react';
import type { ComponentProps } from 'react';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';

/**
 * The picker Move to… and Add to… open, fetched only once one is chosen and
 * never on a cold open (the boundary `PanelBoard.tsx` draws around
 * `FilterQuestion`), which keeps it out of the initial bundle's budget.
 */
const MoveToPicker = lazy(() => import('./MoveToPicker'));

/** The picker with the boundary around it, so a chunk that does not arrive closes it rather than the list. */
export function FetchedPicker({
  onFailure,
  ...picker
}: ComponentProps<typeof MoveToPicker> & { onFailure: () => void }) {
  return (
    <WhateverTheQuestionDoes onFailure={onFailure}>
      <Suspense fallback={null}>
        <MoveToPicker {...picker} />
      </Suspense>
    </WhateverTheQuestionDoes>
  );
}
