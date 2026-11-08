import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SentEmailEntry } from '@cockpit/shared/sent-emails';
import { FollowSentEmail } from '../../../src/components/FollowSentEmail';
import { FollowRefused, fetchSentEmails, followSentEmail } from '../../../src/api/sentEmails';

vi.mock('../../../src/api/sentEmails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/sentEmails')>()),
  fetchSentEmails: vi.fn(),
  followSentEmail: vi.fn(),
}));

/**
 * F1: the list is rows from the server's answer and a pick is one request
 * ("Follow a sent email… in Capture", issue 1710). What the server lists and
 * what a pick makes are proved at L2
 * (apps/api/tests/integration/connectors/sent-emails-on-the-host.test.ts); the
 * walk from Capture to the Item in the Inbox is tests/e2e/follow-sent-email.test.ts.
 */

const KITCHEN: SentEmailEntry = {
  sourceAccountId: 'src-gmail',
  connectorId: 'gmail',
  mailbox: 'anna@example.com',
  conversationId: 'thread-1',
  subject: 'Quote for the kitchen renovation',
  to: 'Marc Lambrecht',
  sentAt: '2026-10-08T09:15:00.000Z',
  link: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/thread-1',
  excerpt: 'Attached is the quote.',
};
const LEASE: SentEmailEntry = {
  ...KITCHEN,
  sourceAccountId: 'src-outlook',
  connectorId: 'outlook',
  mailbox: 'anna@work.example',
  conversationId: 'conversation-2',
  subject: 'Offer for the office lease',
  to: null,
  sentAt: '2026-10-06T14:40:00.000Z',
};

function theList(options: { decided?: boolean; panelIds?: string[] } = {}) {
  const onBack = vi.fn();
  const onFollowed = vi.fn();
  const page = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FollowSentEmail
        workspaceId="ws-work"
        decided={options.decided ?? true}
        panelIds={options.panelIds ?? []}
        onBack={onBack}
        onFollowed={onFollowed}
      />
    </QueryClientProvider>,
  );
  return { onBack, onFollowed, unmount: page.unmount, user: userEvent.setup() };
}

const rows = () => within(screen.getByRole('list')).getAllByRole('button');

describe('Follow a sent email…', () => {
  beforeEach(() => {
    vi.mocked(fetchSentEmails).mockReset();
    vi.mocked(followSentEmail).mockReset();
    vi.mocked(fetchSentEmails).mockResolvedValue({ emails: [KITCHEN, LEASE], failing: [] });
  });

  it('lists the sent emails as the server ordered them, each with who it went to, how long ago and from which mailbox', async () => {
    theList();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(vi.mocked(fetchSentEmails)).toHaveBeenCalledWith('ws-work');
    expect(rows()[0]).toHaveTextContent('Quote for the kitchen renovation');
    expect(rows()[0]).toHaveTextContent('To Marc Lambrecht');
    expect(rows()[0]).toHaveTextContent('anna@example.com');
    expect(rows()[1]).toHaveTextContent('To nobody named');
  });

  it('says the mailbox that could not be read, and why, beside the rest', async () => {
    vi.mocked(fetchSentEmails).mockResolvedValue({
      emails: [KITCHEN],
      failing: [{ mailbox: 'anna@work.example', why: 'Outlook did not answer. Try again in a moment.' }],
    });

    theList();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'anna@work.example could not be read: Outlook did not answer. Try again in a moment.',
    );
    expect(rows()).toHaveLength(1);
  });

  it('says so when nothing has been sent', async () => {
    vi.mocked(fetchSentEmails).mockResolvedValue({ emails: [], failing: [] });

    theList();

    expect(await screen.findByText('Nothing sent from the connected mailboxes yet.')).toBeVisible();
  });

  it('says so when the list could not be read at all', async () => {
    vi.mocked(fetchSentEmails).mockRejectedValue(new Error('offline'));

    theList();

    expect(await screen.findByText('Your sent emails could not be read. Try again in a moment.')).toBeVisible();
  });

  it('follows the pick as Capture filed it, and tells Capture what was followed', async () => {
    vi.mocked(followSentEmail).mockResolvedValue({ itemId: '11111111-1111-4111-8111-111111111111', made: true });
    const { user, onFollowed } = theList({ decided: false, panelIds: ['p-falcon'] });
    await waitFor(() => expect(rows()).toHaveLength(2));

    await user.click(rows()[1]!);

    await waitFor(() =>
      expect(onFollowed).toHaveBeenCalledWith({
        itemId: '11111111-1111-4111-8111-111111111111',
        subject: 'Offer for the office lease',
        made: true,
      }),
    );
    expect(vi.mocked(followSentEmail)).toHaveBeenCalledWith('ws-work', {
      sourceAccountId: 'src-outlook',
      conversationId: 'conversation-2',
      subject: 'Offer for the office lease',
      to: null,
      sentAt: '2026-10-06T14:40:00.000Z',
      link: LEASE.link,
      excerpt: 'Attached is the quote.',
      decided: false,
      panelIds: ['p-falcon'],
    });
  });

  it('sends one pick at a time, however often it is pressed', async () => {
    let answer: (value: { itemId: string; made: boolean }) => void = () => {};
    vi.mocked(followSentEmail).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { user } = theList();
    await waitFor(() => expect(rows()).toHaveLength(2));

    await user.click(rows()[0]!);
    await user.click(rows()[0]!);
    await user.click(rows()[1]!);

    expect(vi.mocked(followSentEmail)).toHaveBeenCalledTimes(1);
    answer({ itemId: '11111111-1111-4111-8111-111111111111', made: true });
  });

  it('says why a pick was refused and leaves the list to pick again from', async () => {
    vi.mocked(followSentEmail).mockRejectedValue(
      new FollowRefused('The item made from this email is finished. Reopen it from Done, or follow a different email.'),
    );
    const { user, onFollowed } = theList();
    await waitFor(() => expect(rows()).toHaveLength(2));

    await user.click(rows()[0]!);

    expect(await screen.findByRole('alert')).toHaveTextContent('The item made from this email is finished.');
    expect(onFollowed).not.toHaveBeenCalled();
    await waitFor(() => expect(rows()[0]).toBeEnabled());
  });

  it('goes back to the note', async () => {
    const { user, onBack } = theList();

    await user.click(screen.getByRole('button', { name: '← Back to the note' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
