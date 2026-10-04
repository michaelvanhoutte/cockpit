import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapturePage } from '../../../src/pages/CapturePage';

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
const at = vi.hoisted(() => ({ state: {} as Record<string, unknown>, pathname: '/capture' }));
const drawn = vi.hoisted(() => ({ startsIn: undefined as unknown }));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { state: at.state, pathname: at.pathname } }),
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
  CaptureNote: ({ startsIn }: { startsIn: string | null }) => {
    drawn.startsIn = startsIn;
    return <div data-testid="the-form" />;
  },
}));
vi.mock('../../../src/components/CarCapture', () => ({
  CarCapture: () => <div data-testid="the-car-view" />,
}));

const opened = (pathname: string, state: Record<string, unknown> = {}) => {
  at.pathname = pathname;
  at.state = state;
  render(<CapturePage />);
};
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
});
