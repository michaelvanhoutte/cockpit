import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { itemTypesQuery, snapshotQuery } from '../api/queries';
import { litForChrome } from '../chrome';
import { CaptureForm } from './CaptureForm';

/**
 * Capture from the header, without saying which workspace it belongs to
 * ("Capture something before you know which workspace it belongs to",
 * issue 165).
 *
 * **It is first in the strip and ruled off from the workspaces, rather than one
 * of them**, which is the whole of what it means: the Inbox's own capture row is inside one and
 * has therefore already answered the question, and this one has not. What it
 * makes belongs to no workspace and shows in every workspace's Inbox until
 * somebody says where it goes.
 *
 * **Only where there is a workspace to have been captured from.** An Item
 * records that even while it belongs to none - it is an honest fact and the
 * seed a later router would read - so with no workspace in the address there is
 * nothing to record and no button. That is the workspaces settings page, which
 * is also the one screen with no Inbox for a captured note to land in.
 *
 * The same form the Inbox's row draws, told not to decide: two boxes and a
 * button is what capture is, and a second arrangement of the same two fields
 * would be a second place for them to disagree.
 */
export function CaptureWindow({ workspaceId, tint }: { workspaceId: string; tint: string }) {
  const [open, setOpen] = useState(false);
  const { data: types } = useQuery(itemTypesQuery);
  const { data } = useQuery(snapshotQuery(workspaceId));

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {/* **Capture…, not Capture**, the ellipsis meaning a window opens - the
          same convention Move to… and Add to… already carry. Without it there
          are two controls called Capture on one screen: this one, and the
          Inbox's own box, which captures into the workspace you are in rather
          than asking. Found in the browser, where a walk could not say which
          it meant either. */}
      {/* **The same box a workspace tab has** - `pt-1.5 pb-2` and the same
          top-rounded corners, not a padding of its own inside a wrapper. The
          header is an `items-end` row, so its height is whatever its tallest
          child is: six pixels of extra padding here pushed the whole page down
          by six, which is invisible until a walk that drags a panel by its
          coordinates lands in the wrong gap.

          **Filled with the workspace's tint, which makes it the one saturated
          tab in the strip** ("Cockpit Shell Explorations", artboard 2c). It is
          not one of the workspaces, so it does not take a workspace's fill; it
          is where you land before you have chosen one, so it is not faint
          either. The ink on it is the app's own dark ink rather than white,
          because the tint is lifted for the chrome (`chrome.ts`) and a lifted
          tint is far too light to carry white. */}
      <Dialog.Trigger
        className="shrink-0 self-end rounded-t-lg px-4 pt-1.5 pb-2 text-sm font-medium text-ink"
        style={{ backgroundColor: litForChrome(tint) }}
      >
        Capture…
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">Capture</Dialog.Title>
          <Dialog.Description className="pt-1 text-sm text-ink-soft">
            It will wait in every workspace's Inbox until you say where it belongs.
          </Dialog.Description>
          <div className="pt-4">
            <CaptureForm
              workspaceId={workspaceId}
              // `?? []` for the reason the Inbox's row carries one: a stored
              // snapshot can predate the field, and capture with no types to
              // offer is a box you can type a name into rather than a crash.
              types={types?.itemTypes ?? []}
              items={data?.items ?? []}
              decided={false}
              autoFocus
              // Closed on the way out rather than on the answer coming back:
              // capture must not wait on the network (architecture,
              // "Performance budgets"), and the note is in the Inbox behind
              // this window either way.
              onCaptured={() => setOpen(false)}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
