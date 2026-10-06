import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotSignedIn } from '../../../src/api/client';
import { CapturePage } from '../../../src/pages/CapturePage';
import { aShare, aSharedPhoto, holdAShare, howManyAreHeld } from '../support/shares';

/**
 * F1: the page hands the form the workspace the navigation says it was opened
 * in, and none where it says nothing - a typed `/capture`, or the installed
 * app's shortcut. The form's own rules are
 * tests/unit/components/CaptureNote.test.tsx, and the Car view's are
 * tests/unit/components/CarCapture.test.tsx.
 *
 * What the Write | Car switch does is navigate to the other address with the
 * same state, so the cases read where each side of it goes rather than
 * pressing it: the router that follows the link is not this page's.
 */
const at = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  pathname: '/capture',
  search: {} as Record<string, unknown>,
}));
const drawn = vi.hoisted(() => ({ startsIn: undefined as unknown }));
/** Whether the sign-in holds, as the app's own read of who is signed in answers. */
const session = vi.hoisted(() => ({ signedIn: true }));

vi.mock('../../../src/api/queries', () => ({
  meQuery: {
    queryKey: ['me'],
    queryFn: async () => {
      if (!session.signedIn) throw new (await import('../../../src/api/client')).NotSignedIn('no');
      return { user: { id: 'user-michael', name: 'Michael' } };
    },
  },
}));

const navigated = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  // Takes effect on the mocked address as the router's would.
  useNavigate: () => (args: { search: Record<string, unknown> }) => {
    navigated(args);
    at.search = args.search;
    return Promise.resolve();
  },
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { state: at.state, pathname: at.pathname, search: at.search } }),
  Link: ({
    to,
    state,
    children,
    'aria-current': current,
  }: {
    to: string;
    state: unknown;
    children: React.ReactNode;
    'aria-current'?: 'page';
  }) => (
    <a href={to} aria-current={current} data-state={JSON.stringify(state)}>
      {children}
    </a>
  ),
}));
vi.mock('../../../src/components/CaptureNote', () => ({
  // Shows what it was handed, which is what the person would find on the note.
  CaptureNote: ({
    startsIn,
    arrived,
    onPutOn,
    onCaptured,
  }: {
    startsIn: string | null;
    arrived?: { message: string; files: File[] } | null;
    onPutOn?: () => void;
    onCaptured?: () => void;
  }) => {
    drawn.startsIn = startsIn;
    // As the form does once it has put what it was handed on the note.
    useEffect(() => {
      if (arrived) onPutOn?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [arrived]);
    return (
      <div data-testid="the-form">
        <button onClick={onCaptured}>a capture lands</button>
        {arrived && <p data-testid="on-the-note">{[arrived.message, ...arrived.files.map((f) => f.name)].join(' + ')}</p>}
      </div>
    );
  },
}));
vi.mock('../../../src/components/CarCapture', () => ({
  CarCapture: () => <div data-testid="the-car-view" />,
}));

const opened = (pathname: string, state: Record<string, unknown> = {}, search: Record<string, unknown> = {}) => {
  at.pathname = pathname;
  at.state = state;
  at.search = search;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = render(
    <QueryClientProvider client={client}>
      <CapturePage />
    </QueryClientProvider>,
  );
  return {
    client,
    /** The page drawn again over the same session, at whatever the mocked address now says. */
    again: () =>
      page.rerender(
        <QueryClientProvider client={client}>
          <CapturePage />
        </QueryClientProvider>,
      ),
  };
};
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  session.signedIn = true;
});
const writeSide = () => screen.getByRole('link', { name: 'Write' });
const carSide = () => screen.getByRole('link', { name: 'Car' });

describe('Capture', () => {
  it('starts on the workspace the tab was pressed in', async () => {
    opened('/capture', { captureFrom: 'ws-work' });

    // The form is fetched behind the shell (`captureForm.ts`).
    expect(await screen.findByTestId('the-form')).toBeVisible();
    expect(drawn.startsIn).toBe('ws-work');
  });

  it('starts on Any workspace when it was reached from outside one', async () => {
    opened('/capture');

    await screen.findByTestId('the-form');
    expect(drawn.startsIn).toBeNull();
  });

  describe('Capture has two views, Write and Car, one switch apart both ways', () => {
    it('opens the Write form with Write lit at /capture', async () => {
      opened('/capture');

      expect(await screen.findByTestId('the-form')).toBeVisible();
      expect(screen.queryByTestId('the-car-view')).toBeNull();
      expect(writeSide()).toHaveAttribute('aria-current', 'page');
      expect(carSide()).not.toHaveAttribute('aria-current');
    });

    it('opens the Car view with Car lit at /capture/car', async () => {
      opened('/capture/car');

      expect(await screen.findByTestId('the-car-view')).toBeVisible();
      expect(screen.queryByTestId('the-form')).toBeNull();
      expect(carSide()).toHaveAttribute('aria-current', 'page');
      expect(writeSide()).not.toHaveAttribute('aria-current');
    });

    it.each([
      ['Write to Car', '/capture', carSide, '/capture/car'],
      ['Car back to Write', '/capture/car', writeSide, '/capture'],
    ])('goes %s keeping the workspace it was opened in', async (_way, from, side, to) => {
      opened(from, { captureFrom: 'ws-work' });

      expect(side()).toHaveAttribute('href', to);
      expect(JSON.parse(side().dataset.state!)).toEqual({ captureFrom: 'ws-work' });
    });

    it('carries no workspace over the switch where it was opened outside one', async () => {
      opened('/capture');

      expect(JSON.parse(carSide().dataset.state!)).toEqual({});
    });
  });

  describe('the Capture page puts what was shared on the note', () => {
    it('hands a held photo and text to the form, and empties the holding area', async () => {
      await holdAShare(aShare({ text: 'Worth a read', files: [aSharedPhoto()] }));

      opened('/capture');

      expect(await screen.findByTestId('on-the-note')).toHaveTextContent('Worth a read + photo.png');
      expect(await howManyAreHeld()).toBe(0);
    });

    it('shows nothing the next time Capture is opened, the share having been claimed', async () => {
      await holdAShare(aShare({ text: 'Worth a read' }));
      opened('/capture');
      await screen.findByTestId('on-the-note');

      cleanup();
      opened('/capture');

      await screen.findByTestId('the-form');
      await waitFor(() => expect(screen.queryByTestId('on-the-note')).toBeNull());
    });

    it('puts a share on the note once, not again when Write is drawn again after Car', async () => {
      await holdAShare(aShare({ text: 'Worth a read' }));
      const { again } = opened('/capture');
      await screen.findByTestId('on-the-note');

      at.pathname = '/capture/car';
      again();
      await screen.findByTestId('the-car-view');
      at.pathname = '/capture';
      again();

      await screen.findByTestId('the-form');
      expect(screen.queryByTestId('on-the-note')).toBeNull();
    });

    it('leaves the Car view alone, which has no note to put it on', async () => {
      await holdAShare(aShare({ text: 'Worth a read' }));

      const { client } = opened('/capture/car');
      await screen.findByTestId('the-car-view');
      // Past the point where the Write form would have claimed it: the sign-in
      // read, and the page drawn again on it.
      await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('success'));
      await act(async () => {});

      // A read of the area queues behind any claim already made on it.
      expect(await howManyAreHeld()).toBe(1);
    });
  });

  describe('a share is never lost to signing in, and signing out removes it', () => {
    it('claims nothing while signed out, and shows it once signed in', async () => {
      await holdAShare(aShare({ text: 'Worth a read' }));
      session.signedIn = false;
      const first = opened('/capture');
      await screen.findByTestId('the-form');
      // The sign-in is read and refused before anything could be claimed.
      await waitFor(() => expect(first.client.getQueryState(['me'])?.status).toBe('error'));
      expect(screen.queryByTestId('on-the-note')).toBeNull();
      expect(await howManyAreHeld()).toBe(1);

      cleanup();
      session.signedIn = true;
      opened('/capture');

      expect(await screen.findByTestId('on-the-note')).toHaveTextContent('Worth a read');
    });

    it('claims nothing on a stored copy of who is signed in that the server then refuses', async () => {
      await holdAShare(aShare({ text: 'Worth a read' }));
      session.signedIn = false;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(['me'], { user: { id: 'user-michael', name: 'Michael' } });
      client.invalidateQueries({ queryKey: ['me'] });
      at.pathname = '/capture';
      at.state = {};
      at.search = {};
      render(
        <QueryClientProvider client={client}>
          <CapturePage />
        </QueryClientProvider>,
      );

      await waitFor(() => expect(client.getQueryState(['me'])?.error).toBeInstanceOf(NotSignedIn));
      expect(screen.queryByTestId('on-the-note')).toBeNull();
      expect(await howManyAreHeld()).toBe(1);
    });
  });

  describe('a share the app cannot receive says so', () => {
    it('says it could not receive what was shared where Capture was opened with the signal', async () => {
      opened('/capture', {}, { share: 'failed' });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't receive what you shared — update Cockpit and share again.",
      );
    });

    it('says nothing without it', async () => {
      opened('/capture');

      await screen.findByTestId('the-form');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('takes the signal out of the address, replacing the entry, and keeps saying it', async () => {
      navigated.mockClear();
      const { again } = opened('/capture', { captureFrom: 'ws-work' }, { share: 'failed' });
      await screen.findByRole('alert');

      await waitFor(() => expect(navigated).toHaveBeenCalledWith(expect.objectContaining({ to: '/capture', search: {}, replace: true })));
      again();

      expect(screen.getByRole('alert')).toBeVisible();
    });

    it('stops saying it once a share is put on the note', async () => {
      await holdAShare(aShare({ text: 'Worth a read' }));

      opened('/capture', {}, { share: 'failed' });

      await screen.findByTestId('on-the-note');
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it.each([
      { situation: 'a capture lands', then: async () => userEvent.click(screen.getByRole('button', { name: 'a capture lands' })) },
    ])('stops saying it once $situation', async ({ then }) => {
      opened('/capture', {}, { share: 'failed' });
      await screen.findByRole('alert');

      await then();

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });
  });
});
