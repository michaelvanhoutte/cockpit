import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The surfaces the Violet workspace was wearing before the palette changed - a
 * pale header over a pale ground, which is what a browser holding a stored copy
 * of a workspace from an older release still has.
 */
const AN_OLDER_PALETTE = { bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' };

const params: { workspaceId?: string } = {};
/** What the two workspaces are wearing, so a case can hand them older colours. */
const VIOLET_SURFACES = { bar: VIOLET.bar, ground: VIOLET.ground, header: VIOLET.header };
const wearing: { violet: typeof VIOLET_SURFACES } = { violet: VIOLET_SURFACES };

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
  // No item named, so the shell draws no form over itself - these cases are
  // about the chrome.
  useSearch: () => ({}),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));

vi.mock('../../../src/components/DashboardBar', () => ({
  DashboardBar: ({ tint, ground }: { tint: string; ground: string }) => (
    <div data-testid="dashboard-strip" data-tint={tint} data-ground={ground} />
  ),
}));

// The column itself is not what these cases are about; its heading is, because
// the shell is what puts that in the band and names the column by it. The stub
// renders the id it is handed, which is the whole of the wiring under test.
vi.mock('../../../src/components/InboxPanel', () => ({
  InboxPanel: () => null,
  InboxHeading: ({ id }: { id?: string }) => <h2 id={id}>Inbox</h2>,
}));

vi.mock('../../../src/api/queries', () => ({
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
            id: 'ws-violet',
            tenantId: 'tenant',
            name: 'Violet workspace',
            color: VIOLET.tint,
            ...wearing.violet,
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
  // Read by the shell so a workspace that cannot be read is said once rather
  // than by each thing reading it; these cases are about color, so it answers.
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: [], dashboards: [] }),
  }),
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

/** A screen wide enough for the Inbox to be a column beside the dashboards. */
function withRoomForTheInbox() {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  delete params.workspaceId;
  wearing.violet = VIOLET_SURFACES;
});

afterEach(() => {
  vi.unstubAllGlobals();
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

      // The band is the shell's own now, so the colour the workspace tab joins
      // onto is read from it rather than from the tabs inside it.
      const band = within(container).getByTestId('dashboard-strip').parentElement!;
      expect(filledWith(band)).toBe(rgb(BLUE.bar));

      const strip = within(container).getByTestId('dashboard-strip');
      expect(strip.dataset.tint).toBe(BLUE.tint);
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

    it('paints a workspace wearing colours the palette no longer has in the theme its tint belongs to', async () => {
      // A browser opening on a stored copy from before the palette changed, or
      // a workspace whose tint was never in the palette at all. The chrome's
      // text is a fixed light set now, so those older pale surfaces are not the
      // wrong shade - they are a bar its own text cannot be read on.
      wearing.violet = AN_OLDER_PALETTE;
      params.workspaceId = 'ws-violet';

      const { container, tab } = await theShell();

      expect(filledWith(container.querySelector('header'))).toBe(rgb(VIOLET.header));
      expect(filledWith(container.firstElementChild)).toBe(rgb(VIOLET.ground));
      expect(filledWith(tab('Violet workspace'))).toBe(rgb(VIOLET.bar));
    });

    it('paints in the default theme where there is no workspace to be in, rather than in nothing', async () => {
      // The workspaces settings page is reached without one.
      const { container } = await theShell();

      expect(filledWith(container.querySelector('header'))).toBe(rgb(VIOLET.header));
      expect(filledWith(container.firstElementChild)).toBe(rgb(VIOLET.ground));
      expect(within(container).queryByTestId('dashboard-strip')).not.toBeInTheDocument();
    });
  });

  describe('the Inbox is headed in the band, above the column it names', () => {
    // F1: where the heading is drawn and what it names are the shell's own
    // arrangement. How many items it counts is the Inbox's, and is asked in
    // tests/unit/components/InboxPanel.test.tsx.
    it('puts the name in the band beside the dashboard tabs, and names the column with it', async () => {
      withRoomForTheInbox();
      params.workspaceId = 'ws-blue';

      const { container } = await theShell();

      // In the band: the same element the dashboard tabs are inside.
      const band = within(container).getByTestId('dashboard-strip').parentElement!;
      const heading = within(band).getByRole('heading', { name: 'Inbox' });

      // And it is what the column below answers to, rather than a label of its
      // own that could drift from the words on screen.
      const column = within(container).getByRole('complementary', { name: 'Inbox' });
      expect(column.getAttribute('aria-labelledby')).toBe(heading.id);
    });

    it('leaves the band unheaded where there is no room for a column', async () => {
      // A phone: the Inbox is a tab in the bar opening a screen of its own, and
      // that screen carries its own name.
      params.workspaceId = 'ws-blue';

      const { container } = await theShell();

      expect(within(container).queryByRole('heading', { name: 'Inbox' })).toBeNull();
      expect(within(container).queryByRole('complementary')).toBeNull();
    });
  });
});
