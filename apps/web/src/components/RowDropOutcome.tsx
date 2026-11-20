import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useSendCommand, useLatestSnapshot } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { performRowDrop, settleRowDrop, type Asking, type LetGo, type RowDropDeps } from '../rowDrop';
import { useUndo } from '../undo';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';

/** Asked once a drop asks it, as the question between Panels is. */
const MoveOrAddQuestion = lazy(() => import('./MoveOrAddQuestion'));

/**
 * What one drop onto a row's middle half comes to, once let go ("Drag to nest
 * in Panels and the Inbox", issue 1857): the move-or-add question where it
 * asks, the change sent where it does not, and the reason where it is refused.
 * Fetched with the drop rather than carried in the initial bundle, which holds
 * only the drag itself (`useNestingDrop`); mounted afresh for each drop.
 */
export default function RowDropOutcome({ workspaceId, letGo }: { workspaceId: string; letGo: LetGo }) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const latest = useLatestSnapshot();
  const offerToUndo = useUndo();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const deps: RowDropDeps = { workspaceId, data, send, latest, offerToUndo, setRefusal };
  const settled = useRef(false);

  // Once, as the copy the drop was made over is at hand.
  useEffect(() => {
    if (settled.current || !data) return;
    settled.current = true;
    const outcome = settleRowDrop(deps, letGo);
    if (!outcome) return;
    if ('refused' in outcome) setRefusal(outcome.refused);
    else if (outcome.plan.answer === 'ask') setAsking(outcome);
    else performRowDrop(deps, outcome, outcome.plan.answer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settled once, with the copy of the moment
  }, [data]);

  return (
    <>
      {refusal && (
        <p role="alert" className="px-4 py-2 text-sm text-over-ink">
          {refusal}
        </p>
      )}
      {asking && (
        <WhateverTheQuestionDoes onFailure={() => setAsking(null)}>
          <Suspense fallback={null}>
            <MoveOrAddQuestion
              open
              itemTitle={asking.title}
              panelName={asking.label}
              leaves={asking.leaves}
              {...(asking.several ? { several: asking.several } : {})}
              onMove={() => {
                setAsking(null);
                performRowDrop(deps, asking, 'move');
              }}
              onAdd={() => {
                setAsking(null);
                performRowDrop(deps, asking, 'add');
              }}
              onCancel={() => setAsking(null)}
            />
          </Suspense>
        </WhateverTheQuestionDoes>
      )}
    </>
  );
}
