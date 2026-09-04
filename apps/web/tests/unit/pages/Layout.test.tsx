import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../../../src/pages/Layout';

/**
 * F1, and one case only. This is not a test of React's escaping, which is
 * framework mechanics and would be cut - it guards the one way Cockpit can undo
 * that escaping itself. Nothing in the codebase reaches for
 * `dangerouslySetInnerHTML` today, and this is what would go red on the day
 * something does, on the screen where every workspace name in the tenant is
 * rendered ("Workspace names are only case-insensitive in ASCII", issue 91).
 */
const A_NAME_THAT_LOOKS_LIKE_MARKUP = '<img src=x onerror=alert(1)>';

// The router itself is not under test, and `to`/`params` are its props rather
// than an anchor's, so they stop here instead of being spread onto the DOM.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  Outlet: () => null,
  useParams: () => ({}),
  useNavigate: () => () => Promise.resolve(),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));

vi.mock('../../../src/api/queries', () => ({
  // Signed in, so the shell renders rather than sending itself to the logon
  // page - which is what this case needs on screen to look at.
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ user: { id: 'user-michael', name: 'Michael' } }),
  },
  // The header's capture window reads the account's types ('Capture something
  // before you know which workspace it belongs to', issue 165). Empty here:
  // what the window offers is CaptureForm's, proved on CaptureForm.
  itemTypesQuery: {
    queryKey: ['itemTypes'],
    queryFn: () => Promise.resolve({ itemTypes: [] }),
  },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [
          {
            id: 'ws-markup',
            tenantId: 'tenant',
            name: '<img src=x onerror=alert(1)>',
            color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea',
          },
        ],
      }),
  },
  // Read by the shell so a workspace that cannot be read is said once rather
  // than by each thing reading it; this case is about the tab, so it answers.
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: [], dashboards: [] }),
  }),
}));

describe('Workspace management', () => {
  describe('a workspace name is shown as text, never as markup', () => {
    it('puts the characters in the tab and builds nothing out of them', async () => {
      const { container } = render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      expect(await screen.findByText(A_NAME_THAT_LOOKS_LIKE_MARKUP)).toBeVisible();
      expect(container.querySelector('img')).toBeNull();
    });
  });
});
