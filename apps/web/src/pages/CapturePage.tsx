import { useRouterState } from '@tanstack/react-router';
import { CaptureNote } from '../components/CaptureNote';

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
 */
export function CapturePage() {
  const startsIn = useRouterState({
    select: (state) => (state.location.state as CaptureState).captureFrom ?? null,
  });

  return (
    /* The sheet's own hollow, the same one a panel's list sits in ("Cockpit
       Shell Explorations", artboard 2c): this screen is one thing rather than a
       page of cards, so it is one well. */
    <section className="well flex min-h-full flex-col px-4 pt-[18px] pb-[14px] sm:px-10 sm:pt-[30px] sm:pb-[22px]">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xs font-semibold tracking-[0.11em] text-accent-deep uppercase sm:text-[15px]">
          Capture
        </h1>
        {/* Gone on a phone, where the heading and the box below it already say
            the same thing in the space there is. */}
        <span className="hidden text-[13px] text-ink-faint sm:inline">
          Write it down now, decide where it belongs later.
        </span>
      </div>
      <CaptureNote startsIn={startsIn} />
    </section>
  );
}
