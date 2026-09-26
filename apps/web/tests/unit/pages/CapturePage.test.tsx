import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapturePage } from '../../../src/pages/CapturePage';

/**
 * F1: the page hands the form the workspace the navigation says it was opened
 * in, and none where it says nothing - a typed `/capture`, or the installed
 * app's shortcut. The form's own rules are
 * tests/unit/components/CaptureNote.test.tsx.
 */
const at = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const drawn = vi.hoisted(() => ({ startsIn: undefined as unknown }));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { state: at.state } }),
}));
vi.mock('../../../src/components/CaptureNote', () => ({
  CaptureNote: ({ startsIn }: { startsIn: string | null }) => {
    drawn.startsIn = startsIn;
    return <div data-testid="the-form" />;
  },
}));

describe('Capture', () => {
  it('starts on the workspace the tab was pressed in', () => {
    at.state = { captureFrom: 'ws-work' };
    render(<CapturePage />);

    expect(screen.getByTestId('the-form')).toBeVisible();
    expect(drawn.startsIn).toBe('ws-work');
  });

  it('starts on Any workspace when it was reached from outside one', () => {
    at.state = {};
    render(<CapturePage />);

    expect(drawn.startsIn).toBeNull();
  });
});
