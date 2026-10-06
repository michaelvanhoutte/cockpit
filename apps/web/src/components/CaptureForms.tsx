import { Suspense, useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { SHARE_FAILED_MESSAGE } from '@cockpit/shared';
import { NotSignedIn } from '../api/client';
import { meQuery } from '../api/queries';
import { CarCapture, CaptureNote } from '../captureForm';
import { useArrived } from '../shareClaim';

/**
 * Both sides of the Capture page's Write | Car switch, and what was shared into
 * Cockpit ("Share photos, files and links into Cockpit from Android's share
 * sheet", issue 789). Here rather than on the page, so the first bundle carries
 * none of it, and around both forms, so a share not yet captured outlives the
 * switch.
 *
 * **Claimed by the Write form, once the sign-in is known to hold**: a share made
 * while signed out, or with the sign-in expired, stays held until Capture is
 * reached signed in. A share the Worker had to turn away arrives as
 * `?share=failed`, said once and then taken out of the address, replacing the
 * entry so Back does not return to it and a reload does not say it again; gone
 * once a capture is made or a share is put on the note.
 */
export function CaptureForms({
  startsIn,
  inCar,
  carried,
}: {
  startsIn: string | null;
  inCar: boolean;
  /** The page's navigation state, kept when the signal is taken out of the address. */
  carried: never;
}) {
  const arrivedFailed = useRouterState({
    select: (state) => (state.location.search as { share?: unknown }).share === 'failed',
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const [shareFailed, setShareFailed] = useState(false);
  useEffect(() => {
    if (!arrivedFailed) return;
    setShareFailed(true);
    void navigate({ to: pathname as never, search: {} as never, replace: true, state: carried });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivedFailed]);
  // Settled, not just stored: the copy of who is signed in can outlive the sign-in.
  const { data: me, error: sessionFailure, isFetching } = useQuery(meQuery);
  const signedIn = Boolean(me) && !isFetching && !(sessionFailure instanceof NotSignedIn);
  const { arrived, taken } = useArrived(signedIn && !inCar);
  return (
    <>
      {shareFailed && (
        <p role="alert" data-share-failed="" className="mt-3 text-sm text-over">
          {SHARE_FAILED_MESSAGE}
        </p>
      )}
      <Suspense fallback={null}>
        {inCar ? <CarCapture /> : (
          <CaptureNote
            startsIn={startsIn}
            arrived={arrived}
            onPutOn={() => setShareFailed(false)}
            onCaptured={() => {
              taken();
              setShareFailed(false);
            }}
          />
        )}
      </Suspense>
    </>
  );
}
