import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { itemTypesQuery, snapshotQuery } from '../api/queries';
import { CaptureForm } from './CaptureForm';

/**
 * Capture from the header, without saying which workspace it belongs to
 * ("Capture something before you know which workspace it belongs to",
 * issue 165).
 *
 * **It sits beside the workspace tabs rather than inside a workspace**, which
 * is the whole of what it means: the Inbox's own capture row is inside one and
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
export function CaptureWindow({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const { data: types } = useQuery(itemTypesQuery);
  const { data } = useQuery(snapshotQuery(workspaceId));

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep">
        Capture
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
