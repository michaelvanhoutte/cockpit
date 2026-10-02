import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Usage } from '@cockpit/shared';
import UsageWindow from '../../../src/components/UsageWindow';

/**
 * F1: what the window draws from what it is given. That only an admin may read
 * usage is the server's rule and is proved against a real register at
 * apps/api/tests/integration/http/usage.test.ts; what is asked here is the half
 * that lives in the browser - the four states a read passes through, and that a
 * referrer, which is client input, is drawn as text and never as markup.
 */

const reads = vi.fn();

vi.mock('../../../src/api/queries', () => ({
  usageQuery: (days: number) => ({ queryKey: ['usage', days], queryFn: () => reads(days) }),
}));

afterEach(() => {
  reads.mockReset();
});

const EMPTY: Usage = {
  days: 30,
  analyticsUrl: null,
  named: [],
  guests: { perDay: [], byCountry: [], byReferrer: [] },
};

const POPULATED: Usage = {
  days: 30,
  analyticsUrl: null,
  named: [
    {
      userId: 'user-michael',
      name: 'Michael',
      latest: '2026-10-02T09:15:00.000Z',
      signIns: ['2026-10-02T09:15:00.000Z', '2026-09-30T18:00:00.000Z'],
    },
    { userId: 'user-ada', name: 'Ada', latest: null, signIns: [] },
  ],
  guests: {
    perDay: [
      { day: '2026-10-02', sessions: 3, itemsCaptured: 5, dashboardsOpened: 2 },
      { day: '2026-10-01', sessions: 1, itemsCaptured: 0, dashboardsOpened: 1 },
    ],
    byCountry: [
      { country: 'BE', sessions: 3 },
      { country: null, sessions: 1 },
    ],
    byReferrer: [
      { host: 'news.example.com', sessions: 3 },
      { host: null, sessions: 1 },
    ],
  },
};

function drawn(onClose = () => {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UsageWindow open onClose={onClose} />
    </QueryClientProvider>,
  );
}

describe('User management', () => {
  describe('the usage window says what it is doing, and what went wrong', () => {
    it('says it is reading while the answer is on its way', async () => {
      reads.mockReturnValue(new Promise(() => {}));
      drawn();

      expect(await screen.findByText('Reading usage…')).toBeVisible();
    });

    it('says so when there is nothing to show', async () => {
      reads.mockResolvedValue(EMPTY);
      drawn();

      expect(await screen.findByText('No guest sessions in the last 30 days.')).toBeVisible();
    });

    it('draws the sign-ins and the guest sessions when it has them', async () => {
      reads.mockResolvedValue(POPULATED);
      drawn();

      const michael = await screen.findByRole('list', { name: 'Sign-ins of Michael' });
      expect(within(michael).getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByText('Has not signed in yet')).toBeVisible();
      const days = within(screen.getByRole('table', { name: 'Guest sessions per day' }));
      expect(days.getByText('2026-10-02')).toBeVisible();
      expect(screen.getByText('BE')).toBeVisible();
      expect(screen.getByText('news.example.com')).toBeVisible();
      // Missing ones are said, not left blank.
      expect(screen.getAllByText('Unknown')).toHaveLength(2);
    });

    it('offers another go when it could not be read, and draws the answer once it can', async () => {
      const user = userEvent.setup();
      reads.mockRejectedValueOnce(new Error('usage failed: 500'));
      reads.mockResolvedValue(POPULATED);
      drawn();

      expect(await screen.findByRole('alert')).toHaveTextContent('Usage could not be read just now.');
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('list', { name: 'Sign-ins of Michael' })).toBeVisible();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says it is for admins when the server refused it as such, and not that it failed', async () => {
      reads.mockRejectedValue(Object.assign(new Error('usage failed: 403'), { status: 403 }));
      drawn();

      expect(await screen.findByText(/This is for admins/)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('asks for the length of window that was chosen', async () => {
      const user = userEvent.setup();
      reads.mockResolvedValue(EMPTY);
      drawn();
      await screen.findByText('No guest sessions in the last 30 days.');

      await user.selectOptions(screen.getByLabelText('Show the last'), '90');

      expect(reads).toHaveBeenLastCalledWith(90);
    });

    it('closes from its own Done button', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      reads.mockResolvedValue(EMPTY);
      drawn(onClose);

      await user.click(await screen.findByRole('button', { name: 'Done' }));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('the link to page traffic is shown when an address is configured and absent otherwise', () => {
    it('opens the configured address', async () => {
      reads.mockResolvedValue({ ...EMPTY, analyticsUrl: 'https://dash.cloudflare.com/acct/web-analytics' });
      drawn();

      const link = await screen.findByRole('link', { name: /Cloudflare Web Analytics/ });

      expect(link).toHaveAttribute('href', 'https://dash.cloudflare.com/acct/web-analytics');
    });

    it('shows no link when none is configured', async () => {
      reads.mockResolvedValue(EMPTY);
      drawn();
      await screen.findByText('No guest sessions in the last 30 days.');

      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('a referrer is drawn as text and nothing else, whatever it holds', () => {
    it('does not turn markup in a referrer host into elements, nor into a link', async () => {
      const hostile = '<img src=x onerror=alert(1)><a href="https://evil.example">go</a>';
      reads.mockResolvedValue({
        ...POPULATED,
        guests: { ...POPULATED.guests, byReferrer: [{ host: hostile, sessions: 4 }] },
      });
      drawn();

      expect(await screen.findByText(hostile)).toBeVisible();
      expect(document.querySelector('img[src="x"]')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    });
  });
});
