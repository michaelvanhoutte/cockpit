import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ACCOUNT_WIDE, dayOf, daysOnFrom } from '@cockpit/shared';
import ManageFollowUps from '../../../src/components/ManageFollowUps';
import { weekdayDayLabel } from '../../../src/dateFormat';

/**
 * F1: what Settings › Follow-ups draws and what it asks to save ("Choose in
 * Settings how many days to wait for a reply", issue 1465). That the account
 * keeps it, refuses anything else and reads it into every Workspace is L2
 * (`apps/api/tests/integration/http/follow-ups.test.ts`).
 */
const held = vi.hoisted(() => ({
  send: null as unknown as ReturnType<typeof vi.fn>,
  /** A read of the Workspace, which the section makes only where the open page holds no fresh copy. */
  read: null as unknown as ReturnType<typeof vi.fn>,
  /** What the undo bar is asked to say. */
  offer: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../../../src/api/queries', () => ({
  useSendCommand: () => held.send,
  whyNotDone: (failure: unknown) => (failure instanceof Error ? failure.message : 'That could not be done.'),
  snapshotQuery: (workspaceId: string) => ({ queryKey: ['snapshot', workspaceId], queryFn: held.read, staleTime: 15_000 }),
}));

vi.mock('../../../src/undo', () => ({ useUndo: () => held.offer }));

const TODAY = new Date('2026-10-22T10:00:00.000Z');

let queries: QueryClient;
let closeSettings: () => void;

/**
 * Follow-ups over the tab's copy of the Workspace, which carries
 * `followUpDays` where it says: with `copyHeld` false the tab holds none, and
 * with `pageHoldsIt` false Settings was opened where no Workspace is open.
 */
function open(followUpDays: number | undefined, { copyHeld = true, pageHoldsIt = true } = {}) {
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Saved on the device a day ago, as a copy restored on opening the app is.
  if (copyHeld) queries.setQueryData(['snapshot', 'ws-1'], { followUpDays }, { updatedAt: TODAY.getTime() - 86_400_000 });
  const { unmount } = render(
    <QueryClientProvider client={queries}>
      <ManageFollowUps workspaceId="ws-1" pageHoldsIt={pageHoldsIt} />
    </QueryClientProvider>,
  );
  closeSettings = unmount;
  return within(screen.getByRole('group', { name: 'How long to wait' }));
}

const box = () => screen.getByRole('spinbutton', { name: 'Days after you set it' });
const dueIn = (days: number) => `Due ${weekdayDayLabel(daysOnFrom(dayOf(TODAY), days))}`;
const sentDays = () => held.send.mock.calls.map(([change]) => (change as { payload: { days: number } }).payload.days);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  held.send = vi.fn(() => Promise.resolve({ ok: true, applied: true }));
  held.read = vi.fn(() => new Promise<never>(() => {}));
  held.offer = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Settings', () => {
  describe('Follow-ups shows the days the account waits for a reply, and an example of the due date they give', () => {
    it.each([
      { situation: 'the days the account chose', followUpDays: 7, shown: 7 },
      { situation: '3, where the account has not chosen', followUpDays: undefined, shown: 3 },
    ])('shows $situation, without reading for them', ({ followUpDays, shown }) => {
      const panel = open(followUpDays);

      expect(box()).toHaveValue(shown);
      expect(panel.getByText(`Waiting since ${weekdayDayLabel(dayOf(TODAY))}`)).toBeVisible();
      expect(panel.getByText(dueIn(shown))).toBeVisible();
      expect(held.read).not.toHaveBeenCalled();
    });

    it('shows a number chosen on another device once the tab holds it', async () => {
      const panel = open(3);

      act(() => {
        queries.setQueryData(['snapshot', 'ws-1'], { followUpDays: 10 });
      });

      await waitFor(() => expect(box()).toHaveValue(10));
      expect(panel.getByText(dueIn(10))).toBeVisible();
    });

    it('takes a number chosen on another device into a box that has focus but nothing typed, and sends nothing on leaving it', async () => {
      const user = userEvent.setup();
      open(3);
      await user.click(box());

      act(() => {
        queries.setQueryData(['snapshot', 'ws-1'], { followUpDays: 10 });
      });
      await waitFor(() => expect(box()).toHaveValue(10));
      await user.tab();

      expect(held.send).not.toHaveBeenCalled();
    });

    it.each([
      { situation: 'the tab holds no copy of it', followUpDays: undefined, copyHeld: false, pageHoldsIt: true },
      { situation: 'no Workspace is open, and the copy was saved on the device', followUpDays: 7, copyHeld: true, pageHoldsIt: false },
    ])('reads the Workspace where $situation', async ({ followUpDays, copyHeld, pageHoldsIt }) => {
      open(followUpDays, { copyHeld, pageHoldsIt });

      await waitFor(() => expect(held.read).toHaveBeenCalledTimes(1));
    });
  });

  describe('Follow-ups saves a whole number from 1 to 365 on Enter, on leaving the box or on closing Settings', () => {
    it.each([
      { situation: 'leaving the box', finish: '{Tab}' },
      { situation: 'Enter', finish: '{Enter}' },
    ])('saves on $situation, and the example follows at once', async ({ finish }) => {
      const user = userEvent.setup();
      const panel = open(3);

      await user.clear(box());
      await user.type(box(), `5${finish}`);

      expect(held.send).toHaveBeenCalledTimes(1);
      expect(held.send).toHaveBeenCalledWith({
        name: 'set_follow_up_days',
        payload: expect.objectContaining({ workspaceId: ACCOUNT_WIDE, days: 5 }),
      });
      expect(panel.getByText(dueIn(5))).toBeVisible();
    });

    it('saves what the box holds when Settings closes before the box is left', async () => {
      const user = userEvent.setup();
      open(3);

      await user.clear(box());
      await user.type(box(), '5');
      closeSettings();

      expect(sentDays()).toEqual([5]);
    });

    it('saves nothing when the number is the one already kept', async () => {
      const user = userEvent.setup();
      open(7);

      await user.click(box());
      await user.keyboard('{Enter}');
      await user.tab();

      expect(held.send).not.toHaveBeenCalled();
    });

    it.each(['0', '366', '2.5', ''])('refuses “%s” beside the box and saves nothing', async (typed) => {
      const user = userEvent.setup();
      const panel = open(7);

      await user.clear(box());
      if (typed) await user.type(box(), typed);
      await user.keyboard('{Enter}');
      await user.tab();

      expect(panel.getByRole('alert')).toHaveTextContent('Use a whole number from 1 to 365.');
      expect(sentDays()).toEqual([]);
      expect(panel.getByText(dueIn(7))).toBeVisible();
    });

    it('says a number that was not saved was not, and the box and the example go back to the one kept', async () => {
      held.send = vi.fn(() => Promise.reject(new Error('You are offline.')));
      const user = userEvent.setup();
      const panel = open(7);

      await user.clear(box());
      await user.type(box(), '5{Enter}');

      expect(await panel.findByRole('alert')).toHaveTextContent('Not saved. You are offline.');
      expect(box()).toHaveValue(7);
      expect(panel.getByText(dueIn(7))).toBeVisible();
      await user.tab();
      expect(sentDays()).toEqual([5]);
    });

    it('has the undo bar say a number saved on closing Settings was not', async () => {
      held.send = vi.fn(() => Promise.reject(new Error('You are offline.')));
      const user = userEvent.setup();
      open(7);

      await user.clear(box());
      await user.type(box(), '5');
      closeSettings();

      await waitFor(() =>
        expect(held.offer).toHaveBeenCalledWith({ what: 'Waiting 5 days for a reply was not saved. You are offline.' }),
      );
    });
  });
});
