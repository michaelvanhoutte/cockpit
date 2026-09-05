import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import { CaptureWindow } from '../../../src/components/CaptureWindow';

/**
 * F1: the window is a button and a dialog around the capture form, so what is
 * asked here is that it opens, that what it makes belongs to no workspace, and
 * that it closes again. What the form itself offers - the types, the one used
 * last, a name that makes a new type - is CaptureForm's and is proved there.
 *
 * That an item belonging to no workspace then appears in every workspace's
 * Inbox is a query, proved against a real store in
 * apps/api/tests/integration/http/panel-items.test.ts.
 */
const held = vi.hoisted(() => ({
  mutate: vi.fn(),
  /** What the capture is refused with, if it is. */
  refuses: null as Error | null,
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: held.mutate, reset: vi.fn(), isPending: false, error: null }),
  useSendCommand: () => vi.fn(() => Promise.resolve()),
  itemTypesQuery: {
    queryKey: ['itemTypes'],
    queryFn: () =>
      Promise.resolve({
        itemTypes: [
          {
            id: 'ty-action',
            tenantId: 'tenant',
            name: 'Action',
            color: '#6f62b5',
            position: 0,
          },
        ],
      }),
  },
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
        items: [],
        dashboards: [],
        panels: [],
        layouts: [],
        associations: [],
        itemTypes: [],
        filings: [],
        generatedAt: '2026-08-31T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
}));

async function theWindow() {
  held.refuses = null;
  // The real mutation calls back: `onSuccess` is what closes the window, and
  // `onError` is what puts the note back and says why.
  held.mutate = vi.fn((_args, options?: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
    if (held.refuses) options?.onError?.(held.refuses);
    else options?.onSuccess?.();
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CaptureWindow workspaceId="ws-work" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const captured = () =>
  held.mutate.mock.calls.map(([args]) => args).find((args) => args.name === 'capture_item');

describe('Capture', () => {
  describe('capturing from the header makes something that belongs to no workspace', () => {
    it('captures what was typed, saying that where it belongs is undecided', async () => {
      const user = await theWindow();

      await user.click(screen.getByRole('button', { name: 'Capture…' }));
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Where does this go');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(captured().payload.message).toBe('Where does this go');
      expect(captured().payload.workspaceDecided).toBe(false);
      // The workspace it was captured from is still recorded: it is an honest
      // fact, and it is what the foreign key needs.
      expect(captured().payload.workspaceId).toBe('ws-work');
    });

    it('closes once the note has been captured, so the Inbox behind it is in view', async () => {
      const user = await theWindow();

      await user.click(screen.getByRole('button', { name: 'Capture…' }));
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Where does this go');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(screen.queryByRole('dialog')).toBeNull();
    });

    /**
     * The window closes on the answer, not on the press. Closing on the press
     * took a refused capture off the screen along with the only place its
     * refusal could have been read - and the note with it, since the box is
     * cleared the moment the change is asked for.
     */
    it('stays open with the note back in the box when the capture is refused', async () => {
      const user = await theWindow();
      held.refuses = new CommandRefused(404, 'workspace ws-work not found');

      await user.click(screen.getByRole('button', { name: 'Capture…' }));
      await user.type(await screen.findByLabelText('Capture a note or to-do'), 'Where does this go');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('workspace ws-work not found');
      expect(screen.getByLabelText('Capture a note or to-do')).toHaveValue('Where does this go');
    });

    it('captures nothing for an empty box, and stays open', async () => {
      const user = await theWindow();

      await user.click(screen.getByRole('button', { name: 'Capture…' }));
      await screen.findByLabelText('Capture a note or to-do');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      expect(captured()).toBeUndefined();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
