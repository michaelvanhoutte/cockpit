import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UsageWindow from '../../../src/components/UsageWindow';
import { deviceIsIn } from '../support/timeZone';

/**
 * F1: what the Usage window sends when it opens ("Count Settings › Usage's days
 * on your own calendar", issue 1428). The queries are the real ones here, and
 * the network is replaced at its edge, so what is asked is the request the
 * browser would make. Which day a sign-in lands on is the server's, and is
 * settled against a real register at apps/api/tests/integration/http/usage.test.ts.
 */

const EMPTY = { days: 30, analyticsUrl: null, named: [], guests: { perDay: [], byCountry: [], byReferrer: [] } };

/** Answers every read with an empty window and returns the addresses asked for, in order. */
function answeringAndNoting(): URL[] {
  const urls: URL[] = [];
  vi.stubGlobal('fetch', async (request: Request | string | URL) => {
    urls.push(new URL(request instanceof Request ? request.url : String(request), 'http://cockpit.test'));
    return new Response(JSON.stringify(EMPTY), { status: 200 });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('User management', () => {
  describe('opening the usage window asks for the days on the calendar of the device’s own zone', () => {
    it.each([
      { situation: 'Brussels', zone: 'Europe/Brussels' },
      { situation: 'New York', zone: 'America/New_York' },
    ])('sends the zone of a device in $situation with the read', async ({ zone }) => {
      deviceIsIn(zone);
      const asked = answeringAndNoting();

      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <UsageWindow open onClose={() => {}} />
        </QueryClientProvider>,
      );
      await screen.findByText('No guest sessions in the last 30 days.');

      expect(asked).toHaveLength(1);
      expect(asked[0]!.pathname).toBe('/v1/admin/usage');
      expect(asked[0]!.searchParams.get('timeZone')).toBe(zone);
      expect(asked[0]!.searchParams.get('days')).toBe('30');
    });
  });
});
