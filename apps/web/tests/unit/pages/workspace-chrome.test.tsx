import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WORKSPACE_THEMES } from '@cockpit/shared';
import { Layout } from '../../../src/pages/Layout';

/**
 * What the shell is painted in, and which surface gets which color.
 *
 * F1: which element carries which color is component rendering, and a browser
 * proves nothing extra about it. That the colors are recognisable *at a glance*
 * is the claim a browser is for, and it is covered by the end-to-end workspace
 * walk rather than by a second opinion here.
 *
 * The strip below the tabs is stubbed, so this is about what the shell hands
 * down rather than about what that component then does with it - which is
 * tested where it lives, in tests/unit/components/DashboardBar.test.tsx.
 */

const VIOLET = WORKSPACE_THEMES[0]!;
const BLUE = WORKSPACE_THEMES[1]!;

const params: { workspaceId?: string } = {};

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    style,
  }: {
    children?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <a className={className} style={style}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useParams: () => params,
  useNavigate: () => () => Promise.resolve(),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));

vi.mock('../../../src/components/DashboardBar', () => ({
  DashboardBar: ({ bar, ground }: { bar: string; ground: string }) => (
    <div data-testid="dashboard-strip" data-bar={bar} data-ground={ground} />
  ),
}));

vi.mock('../../../src/components/InboxPanel', () => ({ InboxPanel: () => null }));

vi.mock('../../../src/api/queries', () => ({
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ user: { id: 'user-michael', name: 'Michael' } }),
  },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [
          {
            id: 'ws-violet',
            tenantId: 'tenant',
            name: 'Violet workspace',
            color: VIOLET.tint,
            bar: VIOLET.bar,
            ground: VIOLET.ground,
            header: VIOLET.header,
          },
          {
            id: 'ws-blue',
            tenantId: 'tenant',
            name: 'Blue workspace',
            color: BLUE.tint,
            bar: BLUE.bar,
            ground: BLUE.ground,
            header: BLUE.header,
          },
        ],
      }),
  },
}));

/**
 * The shell, with whichever workspace `params` currently says you are in.
 *
 * Queries go through `within(container)` rather than through `screen`, because
 * one case renders the shell twice to compare two workspaces and a document
 * with two shells in it makes every global query ambiguous.
 */
async function theShell() {
  const { container, unmount } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Layout />
    </QueryClientProvider>,
  );
  // Nothing paints the workspaces until the list has arrived.
  await within(container).findByText('Blue workspace');
  return { container, unmount, tab: (name: string) => within(container).getByText(name).closest('a') };
}

/** The color an element is filled with, as the browser reports it back. */
function filledWith(element: Element | null | undefined): string {
  return (element as HTMLElement | null)?.style.backgroundColor ?? '';
}

/** `#rrggbb` in the form a style property comes back as. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

beforeEach(() => {
  delete params.workspaceId;
});

describe('Workspace management', () => {
  describe('the workspace you are in owns the strips below it', () => {
    it('fills the tab you are on with the strip’s own color, and leaves the others unfilled', async () => {
      params.workspaceId = 'ws-blue';

      const { tab } = await theShell();

      expect(filledWith(tab('Blue workspace'))).toBe(rgb(BLUE.bar));
      expect(filledWith(tab('Violet workspace'))).toBe('');
    });

    it('hands the strip below its own color and the page’s, so both tabs have something to meet', async () => {
      params.workspaceId = 'ws-blue';

      const { container } = await theShell();

      const strip = within(container).getByTestId('dashboard-strip');
      expect(strip.dataset.bar).toBe(BLUE.bar);
      expect(strip.dataset.ground).toBe(BLUE.ground);
    });

    it('repaints every surface when the workspace changes, not just the dot', async () => {
      /** The three surfaces of a shell, as they are actually painted. */
      const surfaces = async (workspaceId: string, name: string) => {
        params.workspaceId = workspaceId;
        const { container, unmount, tab } = await theShell();
        const painted = {
          ground: filledWith(container.firstElementChild),
          header: filledWith(container.querySelector('header')),
          tab: filledWith(tab(name)),
        };
        unmount();
        return painted;
      };

      expect(await surfaces('ws-violet', 'Violet workspace')).toEqual({
        ground: rgb(VIOLET.ground),
        header: rgb(VIOLET.header),
        tab: rgb(VIOLET.bar),
      });
      expect(await surfaces('ws-blue', 'Blue workspace')).toEqual({
        ground: rgb(BLUE.ground),
        header: rgb(BLUE.header),
        tab: rgb(BLUE.bar),
      });
    });

    it('paints in the default theme where there is no workspace to be in, rather than in nothing', async () => {
      // The workspaces settings page is reached without one.
      const { container } = await theShell();

      expect(filledWith(container.querySelector('header'))).toBe(rgb(VIOLET.header));
      expect(filledWith(container.firstElementChild)).toBe(rgb(VIOLET.ground));
      expect(within(container).queryByTestId('dashboard-strip')).not.toBeInTheDocument();
    });
  });
});
