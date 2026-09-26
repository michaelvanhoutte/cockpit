import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { Filing, Item, ItemType, WorkspaceSnapshot } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import { PanelAddItemForm } from '../../../src/components/PanelAddItemForm';
import { NO_TYPES } from '../../../src/itemTypes';
import { useCommand, useLatestSnapshot, useSendCommand } from '../../../src/api/queries';

/**
 * F1: what is under test is this row's own choreography - that a submit
 * empties the box, disables itself while out, and sends `add_item_to_panel`
 * with the panel's held order (re-read right before sending) and the new
 * item at the top. What the server does with those two commands, and that a
 * filing refused after a capture landed leaves the item in the Inbox rather
 * than nowhere, is proved against a real store in
 * apps/api/tests/integration/http/panel-items.test.ts.
 */

const held = vi.hoisted(() => ({
  itemTypes: undefined as ItemType[] | undefined,
  items: [] as Item[],
  /** What the panel is filed with *now*, read fresh by `useLatestSnapshot` right before a submit sends. */
  filings: [] as Filing[],
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  useSendCommand: vi.fn(),
  useLatestSnapshot: vi.fn(),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: {
          id: workspaceId,
          tenantId: 'tenant',
          name: 'Work',
          color: '#6f62b5',
          bar: '#dbd7ee',
          ground: '#e3e1f2',
          header: '#d2cdea',
        },
        items: held.items,
        dashboards: [],
        panels: [],
        layouts: [],
        associations: [],
        itemTypes: held.itemTypes,
        screenSizes: [],
        duplicates: [],
        filings: held.filings,
        generatedAt: '2026-08-31T09:00:00.000Z',
      } as unknown as WorkspaceSnapshot),
  }),
}));

const mockUseCommand = vi.mocked(useCommand);
const mockUseSendCommand = vi.mocked(useSendCommand);
const mockUseLatestSnapshot = vi.mocked(useLatestSnapshot);

function aType(name: string, at: number): ItemType {
  return {
    id: `11111111-1111-7111-8111-${String(at).padStart(12, '0')}`,
    tenantId: 'tenant',
    name,
    color: '#6f62b5',
    position: at,
    createdAt: '2026-08-31T08:00:00.000Z',
  };
}

const ACTION = aType('Action', 0);

/**
 * The row, with the capture half wired to answer synchronously (mirroring
 * `CaptureNote.test.tsx`'s own `thePage`) and the filing half reading `held`
 * fresh - through `useLatestSnapshot`, exactly as the component does - and
 * sending through `sent`, which a case can make resolve or reject.
 */
function aRow({
  types = [ACTION] as ItemType[] | null,
  /** The panel's own held order right now - what `useLatestSnapshot` answers with when the row submits. */
  heldOrder = [] as string[],
  refusesCapture,
  sent = vi.fn((_args: unknown) => Promise.resolve({ ok: true, applied: true })),
}: {
  types?: ItemType[] | null;
  heldOrder?: string[];
  refusesCapture?: Error;
  sent?: ReturnType<typeof vi.fn>;
} = {}) {
  held.itemTypes = types ?? undefined;
  held.items = [];
  held.filings = heldOrder.map((itemId, at) => ({ panelId: 'panel-falcon', itemId, position: at }));

  const mutate = vi.fn(
    (_args: unknown, answers?: { onSuccess?: () => void; onError?: (error: Error) => void }) => {
      if (refusesCapture) answers?.onError?.(refusesCapture);
      else answers?.onSuccess?.();
    },
  );
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  mockUseSendCommand.mockReturnValue(sent as never);
  mockUseLatestSnapshot.mockReturnValue(
    (() => Promise.resolve({ filings: held.filings } as unknown as WorkspaceSnapshot)) as never,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PanelAddItemForm workspaceId="ws-work" panelId="panel-falcon" />
    </QueryClientProvider>,
  );
  return { mutate, sent, user: userEvent.setup() };
}

const openTheRow = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: '+ Add an item' }));

const asked = (mutate: ReturnType<typeof vi.fn>, name: string) =>
  mutate.mock.calls.map(([args]) => args).find((args) => args.name === name);

describe('Panels', () => {
  describe('closed by default', () => {
    it('shows only the opener, with none of the Inbox row’s own controls', () => {
      aRow();

      expect(screen.getByRole('button', { name: '+ Add an item' })).toBeVisible();
      expect(screen.queryByLabelText('Capture a note or to-do')).toBeNull();
    });

    it('opens the Inbox’s own message, type dropdown and submit on request', async () => {
      const { user } = aRow();

      await openTheRow(user);

      expect(await screen.findByLabelText('Capture a note or to-do')).toBeVisible();
      expect(screen.getByLabelText('What kind of thing this is')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add' })).toBeVisible();
    });
  });

  describe('submitting files the new item onto this panel, at its top, and closes the row', () => {
    it('captures what was typed, then adds it to the panel ahead of what is already filed', async () => {
      const sent = vi.fn((_args: unknown) => Promise.resolve({ ok: true, applied: true }));
      const { mutate, user } = aRow({ heldOrder: ['already-1', 'already-2'], sent });

      await openTheRow(user);
      const box = await screen.findByLabelText('Capture a note or to-do');
      await user.type(box, '  Buy milk  ');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      const capture = asked(mutate, 'capture_item');
      expect(capture.payload.message).toBe('Buy milk');
      expect(capture.payload.workspaceId).toBe('ws-work');
      // The box empties the moment the capture is asked for, before either
      // answer comes back - the Inbox row's own choreography.
      expect(box).toHaveValue('');

      await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
      const [filed] = sent.mock.calls[0]!;
      expect(filed).toEqual({
        name: 'add_item_to_panel',
        payload: expect.objectContaining({
          workspaceId: 'ws-work',
          panelId: 'panel-falcon',
          itemId: capture.payload.itemId,
          order: [capture.payload.itemId, 'already-1', 'already-2'],
        }),
      });
    });

    it('reads the panel’s held order fresh right before sending, not the one the row opened with', async () => {
      // A second filing landed on the panel after the row opened - `held`
      // changes after `aRow` renders, which is what `useLatestSnapshot`
      // (read at submit time) has to catch and a value captured on open
      // would not.
      const sent = vi.fn((_args: unknown) => Promise.resolve({ ok: true, applied: true }));
      const { mutate, user } = aRow({ heldOrder: ['first'], sent });
      held.filings = [
        { panelId: 'panel-falcon', itemId: 'first', position: 0 },
        { panelId: 'panel-falcon', itemId: 'arrived-while-open', position: 1 },
      ];

      await openTheRow(user);
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      const capture = asked(mutate, 'capture_item');
      await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
      const [filed] = sent.mock.calls[0]!;
      expect((filed as { payload: { order: string[] } }).payload.order).toEqual([
        capture.payload.itemId,
        'first',
        'arrived-while-open',
      ]);
    });

    it('closes back to the opener once the filing lands', async () => {
      const { user } = aRow();

      await openTheRow(user);
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(await screen.findByRole('button', { name: '+ Add an item' })).toBeVisible();
      expect(screen.queryByLabelText('Capture a note or to-do')).toBeNull();
    });
  });

  describe('an empty thought is never captured', () => {
    it('asks for nothing and leaves the row open', async () => {
      const { mutate, user } = aRow();

      await openTheRow(user);
      await user.type(await screen.findByLabelText('Capture a note or to-do'), '   ');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Capture a note or to-do')).toBeVisible();
    });
  });

  describe('cancelling closes the row without capturing, and forgets the type chosen', () => {
    it('sends nothing and hides the fields', async () => {
      const { mutate, user } = aRow();

      await openTheRow(user);
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '+ Add an item' })).toBeVisible();
    });
  });

  describe('with no types to give it, the row says so instead of capturing', () => {
    it('shows no type box, says where one is made, and disables Add', async () => {
      const { mutate, user } = aRow({ types: [] });

      await openTheRow(user);
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(screen.queryByLabelText('What kind of thing this is')).toBeNull();
      expect(screen.getByText(NO_TYPES)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('a thought the account refuses to capture stays in the box, and says why', () => {
    it('restores the message and shows the refusal', async () => {
      const refusesCapture = new CommandRefused(404, 'that workspace is not there any more');
      const { user } = aRow({ refusesCapture });

      await openTheRow(user);
      const box = await screen.findByLabelText('Capture a note or to-do');
      await user.type(box, 'Why is this slow?');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(await screen.findByText('that workspace is not there any more')).toBeVisible();
      expect(box).toHaveValue('Why is this slow?');
    });
  });

  /**
   * Rule 3 of issue 449: a filing refused after the capture landed never
   * loses the item - it is in the Inbox, which this row says rather than
   * pretending nothing happened. Nothing here offers to send it again, which
   * would only capture the same thought a second time.
   */
  describe('a panel deleted in another tab between opening the row and submitting', () => {
    it('says the item was captured but could not be filed here, and does not resend it', async () => {
      const sent = vi.fn((_args: unknown) =>
        Promise.reject(new CommandRefused(404, 'that panel is not there any more')),
      );
      const { mutate, user } = aRow({ sent });

      await openTheRow(user);
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(
        await screen.findByText('Captured, but could not be filed here: that panel is not there any more'),
      ).toBeVisible();
      // Still open, with nothing left in the box to resend.
      expect(screen.getByLabelText('Capture a note or to-do')).toHaveValue('');
      expect(mutate).toHaveBeenCalledTimes(1);
    });
  });

  describe('submitted twice in quick succession', () => {
    it('disables Add while the capture is out, and again while the filing is', async () => {
      let finishSending: (() => void) | undefined;
      const sent = vi.fn(
        (_args: unknown) =>
          new Promise<{ ok: true; applied: true }>((resolve) => {
            finishSending = () => resolve({ ok: true, applied: true });
          }),
      );
      const { user } = aRow({ sent });

      await openTheRow(user);
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Buy milk');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      // The filing is still out - `sent` has not resolved yet - and Add stays
      // disabled through it, not only through the capture half.
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled());

      finishSending?.();
      await screen.findByRole('button', { name: '+ Add an item' });
    });
  });
});
