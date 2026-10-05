import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureNote } from '../../../src/components/CaptureNote';
import { CaptureOutbox, OutboxProvider, browserOutboxStore, inTabLock, serverSender } from '../../../src/captureOutboxSender';

/**
 * F1: a note whose editor never arrives stays plain, with its text, and says
 * so (issue 758).
 *
 * A file of its own because `React.lazy` remembers its first answer for the
 * life of the module registry, so a download that fails cannot share a file
 * with cases that need it to arrive. The editor's file is what is made to
 * fail; the rest of the form is as `CaptureNote.test.tsx` draws it.
 */
vi.mock('../../../src/description/RichDescription', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: vi.fn(), isPending: false }),
  workspacesQuery: { queryKey: ['workspaces'], queryFn: () => Promise.resolve({ workspaces: [] }) },
  itemTypesQuery: { queryKey: ['itemTypes'], queryFn: () => new Promise(() => {}) },
  snapshotQuery: (id: string) => ({ queryKey: ['snapshot', id], queryFn: () => new Promise(() => {}) }),
}));

describe('Capture', () => {
  describe('formatting that cannot load leaves the note plain', () => {
    it('shows the plain box with the text in it, and says formatting could not be loaded', async () => {
      const outbox = new CaptureOutbox({
        store: browserOutboxStore(),
        sender: serverSender,
        lock: inTabLock(),
        online: () => true,
        timeoutMs: 500,
      });
      render(
        <QueryClientProvider client={new QueryClient()}>
          <OutboxProvider value={outbox}>
            <CaptureNote startsIn={null} />
          </OutboxProvider>
        </QueryClientProvider>,
      );
      const plain = await screen.findByRole('textbox', { name: 'What is on your mind?' });
      fireEvent.change(plain, { target: { value: 'Ask Ada' } });

      await userEvent.setup().click(screen.getByRole('button', { name: 'Format the note' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Formatting could not be loaded/));
      const after = screen.getByRole('textbox', { name: 'What is on your mind?' });
      expect(after.tagName).toBe('TEXTAREA');
      expect(after).toHaveValue('Ask Ada');
      expect(screen.getByRole('button', { name: 'Format the note' })).toHaveAttribute('aria-pressed', 'false');
    });
  });
});
