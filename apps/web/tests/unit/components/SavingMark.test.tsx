import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { CommandResult } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { sendCommand } from '../../../src/api/client';
import type { CommandArgs } from '../../../src/api/queries';
import { SavingMark } from '../../../src/components/SavingMark';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(),
}));

/**
 * F1 with fake timers: the header's saving sign, which shows once a change this
 * tab made has waited half a second for the server and not before, and the
 * browser's leave-site prompt that guards the same changes. The server is a
 * request left open until the test answers it.
 */

const server = vi.mocked(sendCommand);
let arrived: { answer: () => void; refuse: () => void }[];

const aChange = (name: string): CommandArgs => ({
  name: 'set_priority',
  payload: { commandId: name, issuedAt: '2026-10-20T09:00:00.000Z', workspaceId: 'ws-work', itemId: 'i-1', priority: 'high' },
});

/** Makes a change the way a screen does and leaves it waiting. */
function makeAChange(name = 'c1') {
  const answered = changes.enqueue(aChange(name));
  answered.catch(() => {});
  return answered;
}

const later = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  arrived = [];
  server.mockReset();
  server.mockImplementation(
    () =>
      new Promise<CommandResult>((resolve, reject) => {
        arrived.push({ answer: () => resolve({ ok: true, applied: true }), refuse: () => reject(new Error('That item is locked.')) });
      }),
  );
});

afterEach(async () => {
  // Whatever a test left unanswered would otherwise be waiting for the next one,
  // each answer letting the next change go out.
  for (let round = 0; round < 5 && changes.unanswered() > 0; round += 1) {
    for (const request of arrived) request.answer();
    await flush();
  }
  changes.forgetAnswered();
  vi.useRealTimers();
});

describe('Item editing', () => {
  describe('the saving sign shows while a change has waited half a second for the server, and only then', () => {
    it('never shows for a change answered within 400 ms', async () => {
      render(<SavingMark />);
      makeAChange();
      await flush();

      await later(400);
      arrived[0]!.answer();
      await flush();
      await later(1000);

      expect(screen.queryByRole('status')).toBeNull();
    });

    it('shows, labelled with how many are waiting, once a change is unanswered at 500 ms', async () => {
      render(<SavingMark />);
      makeAChange();
      await flush();
      await later(499);
      expect(screen.queryByRole('status')).toBeNull();

      await later(1);

      expect(screen.getByRole('status', { name: 'Saving 1 change…' })).toBeVisible();
      expect(screen.getByRole('status')).toHaveAttribute('title', 'Saving 1 change…');
    });

    it('counts two changes waiting', async () => {
      render(<SavingMark />);
      makeAChange('c1');
      makeAChange('c2');
      await flush();
      await later(500);

      expect(screen.getByRole('status', { name: 'Saving 2 changes…' })).toBeVisible();
    });

    it.each([
      { situation: 'the last is answered', end: (request: { answer: () => void; refuse: () => void }) => request.answer() },
      { situation: 'the last is refused', end: (request: { answer: () => void; refuse: () => void }) => request.refuse() },
    ])('goes when $situation', async ({ end }) => {
      render(<SavingMark />);
      makeAChange();
      await flush();
      await later(500);
      expect(screen.getByRole('status')).toBeVisible();

      end(arrived[0]!);
      await flush();

      expect(screen.queryByRole('status')).toBeNull();
    });

    it('stays while one of two is still waiting, and says so', async () => {
      render(<SavingMark />);
      makeAChange('c1');
      makeAChange('c2');
      await flush();
      await later(500);

      arrived[0]!.answer();
      await flush();
      await flush();

      expect(screen.getByRole('status', { name: 'Saving 1 change…' })).toBeVisible();
    });
  });

  describe('leaving the tab asks first while a change is unanswered', () => {
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    it('holds the page while a change is out, and lets it go once it is answered', async () => {
      expect(leave()).toBe(false);

      makeAChange();
      await flush();
      expect(leave()).toBe(true);

      arrived[0]!.answer();
      await flush();

      expect(leave()).toBe(false);
    });
  });
});
