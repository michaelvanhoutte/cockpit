import { Suspense } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { SHARE_FAILED_MESSAGE } from '@cockpit/shared';
import { NotSignedIn } from '../api/client';
import { meQuery } from '../api/queries';
import { CarCapture, CaptureNote } from '../captureForm';
import { useArrived } from '../shares';

/**
 * What the header's tab and `C` put in the navigation's state to say which
 * workspace they were pressed in. State rather than the address: the address is
 * what a link and the installed app's shortcut open, and those come from
 * outside a workspace.
 */
export interface CaptureState {
  captureFrom?: string;
}

/**
 * The state to navigate to `/capture` with. Cast because the router types its
 * state as an interface only an augmentation of `@tanstack/history` can add
 * to, and that package is not this one's to import.
 */
export const captureStateFor = (workspaceId: string | undefined): never =>
  (workspaceId ? { captureFrom: workspaceId } : {}) as CaptureState as never;

/**
 * Capture as a screen of its own ("Capture Page", artboards 2a and 2c): what a
 * phone opens from the header's Capture tab and `C`, and what a link, a typed
 * `/capture` and the installed app's shortcut open at any width. At a desk the
 * tab and `C` open the same form as a window over the screen you are on
 * instead (components/CaptureWindow.tsx).
 *
 * **It belongs to no workspace**, which is why it is not under one in the
 * address (router.tsx): what it makes waits in every workspace's Inbox until
 * somebody says where it goes. Where starts on the workspace you came from
 * where the tab said so, and on *Any workspace* otherwise ("Capture over the
 * screen you are on, and open it with C", issue 536).
 *
 * **Write | Car** in the header switches between the form and the Car view
 * (components/CarCapture.tsx, "Capture by voice in the car", issue 730) and
 * keeps the workspace you came from; `/capture` opens on Write and
 * `/capture/car` on Car. **The Car view can be dark** (`styles.css`, "The dark
 * Car view"): it flags the document while shown dark, and this page's ground,
 * heading and switch are styled from that flag rather than told, so a car-only
 * look costs the first bundle nothing.
 *
 * **What was shared into Cockpit is claimed here** ("Share photos, files and
 * links into Cockpit from Android's share sheet", issue 789), by the Write form
 * and only once the sign-in is known to hold: a share made while signed out, or
 * with the sign-in expired, stays held until this page is reached signed in. A
 * share the Worker had to turn away arrives as `?share=failed` and is said here.
 */
export function CapturePage() {
  const startsIn = useRouterState({
    select: (state) => (state.location.state as CaptureState).captureFrom ?? null,
  });
  const inCar = useRouterState({ select: (state) => state.location.pathname === '/capture/car' });
  const shareFailed = useRouterState({
    select: (state) => (state.location.search as { share?: unknown }).share === 'failed',
  });
  // Settled, not just stored: the copy of who is signed in can outlive the sign-in.
  const { data: me, error: sessionFailure, isFetching } = useQuery(meQuery);
  const signedIn = Boolean(me) && !isFetching && !(sessionFailure instanceof NotSignedIn);
  const arrived = useArrived(signedIn && !inCar);
  // Carried over the switch, so Where still starts on the workspace you came from.
  const carried = captureStateFor(startsIn ?? undefined);

  return (
    /* The sheet's own hollow, the same one a panel's list sits in ("Cockpit
       Shell Explorations", artboard 2c): this screen is one thing rather than a
       page of cards, so it is one well. */
    <section
      data-capture=""
      className="well flex min-h-full flex-col px-4 pt-[18px] pb-[14px] sm:px-10 sm:pt-[30px] sm:pb-[22px]"
    >
      <div className="flex items-baseline gap-3">
        <h1 data-capture-heading="" className="text-xs font-semibold tracking-[0.11em] text-accent-deep uppercase sm:text-[15px]">
          Capture
        </h1>
        {/* Gone on a phone, where the heading and the box below it already say
            the same thing in the space there is. */}
        <span className="hidden text-[13px] text-ink-faint sm:inline">
          Write it down now, decide where it belongs later.
        </span>
        <div
          role="group"
          aria-label="Capture view"
          data-capture-switch=""
          className="ml-auto flex overflow-hidden rounded-md border border-shade/10 bg-white text-sm"
        >
          <Link
            to="/capture"
            state={carried}
            aria-current={inCar ? undefined : 'page'}
            data-lit={inCar ? undefined : ''}
            className={viewClass(!inCar)}
          >
            Write
          </Link>
          <Link
            to="/capture/car"
            state={carried}
            aria-current={inCar ? 'page' : undefined}
            data-lit={inCar ? '' : undefined}
            className={viewClass(inCar)}
          >
            Car
          </Link>
        </div>
      </div>
      {shareFailed && (
        <p role="alert" data-share-failed="" className="mt-3 text-sm text-over">
          {SHARE_FAILED_MESSAGE}
        </p>
      )}
      <Suspense fallback={null}>
        {inCar ? <CarCapture /> : <CaptureNote startsIn={startsIn} arrived={arrived} />}
      </Suspense>
    </section>
  );
}

/** One side of the Write | Car switch: the lit one is the view shown. */
const viewClass = (lit: boolean) =>
  `inline-flex min-h-9 items-center px-3.5 font-medium ${
    lit ? 'bg-accent-tint text-accent-deep' : 'text-ink-faint hover:bg-accent-tint hover:text-ink'
  }`;

