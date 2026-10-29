import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ACCOUNT_WIDE, emailLocalPartSchema, type EmailToCockpit as Held } from '@cockpit/shared';
import { EmailToCockpit } from '../../../src/components/EmailToCockpit';

/**
 * F1: what the *Your account* panel draws and what it asks to change ("Get an
 * Email to Cockpit address, and receive mail at it", issue 1466). That the
 * account holds one address and mail reaches only that one is L2
 * (`apps/api/tests/integration/http/email-to-cockpit.test.ts`); that a person
 * gets one in Settings is the browser walk in `tests/e2e/settings.test.ts`.
 */
const held = vi.hoisted(() => ({
  send: null as unknown as ReturnType<typeof vi.fn>,
  /** What the undo bar is asked to say. */
  offer: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../../../src/api/queries', () => ({
  useSendCommand: () => held.send,
  whyNotDone: (failure: unknown) => (failure instanceof Error ? failure.message : 'That could not be done.'),
}));

vi.mock('../../../src/undo', () => ({ useUndo: () => held.offer }));

const DOMAIN = 'in.cockpit.example';
const HELD = 'k7f3q9xwk7f3q9xwk7f3';

function open(localPart: string | null, guest = false) {
  const view = render(<EmailToCockpit held={{ domain: DOMAIN, localPart }} guest={guest} />);
  const panel = () => within(screen.getByRole('group', { name: 'Your account' }));
  return {
    panel,
    /** What a Workspace's copy says once the change is read back. */
    readBack: (now: Held) => view.rerender(<EmailToCockpit held={now} guest={guest} />),
  };
}

/** The random parts sent, in order: null for turned off. */
const sentParts = () =>
  held.send.mock.calls.map(([change]) => (change as { payload: { localPart: string | null } }).payload.localPart);

const shownAddress = (panel: ReturnType<typeof within>) => panel.getByText(new RegExp(`@${DOMAIN.replaceAll('.', '\\.')}$`)).textContent!;

beforeEach(() => {
  held.send = vi.fn(() => Promise.resolve({ ok: true, applied: true }));
  held.offer = vi.fn();
});

describe('Email to Cockpit', () => {
  describe('Your account offers Get an address until the account holds one, then the address with Copy and its menu', () => {
    it('offers Get an address, and nothing to copy, where the account holds none', () => {
      const { panel } = open(null);

      expect(panel().getByText('Email to Cockpit')).toBeVisible();
      expect(panel().getByRole('button', { name: 'Get an address' })).toBeVisible();
      expect(panel().queryByRole('button', { name: 'Copy' })).toBeNull();
    });

    it('shows the address the account holds, with Copy and its menu', () => {
      const { panel } = open(HELD);

      expect(panel().getByText(`${HELD}@${DOMAIN}`)).toBeVisible();
      expect(panel().getByRole('button', { name: 'Copy' })).toBeVisible();
      expect(panel().getByRole('button', { name: 'More for Email to Cockpit' })).toBeVisible();
      expect(panel().queryByRole('button', { name: 'Get an address' })).toBeNull();
    });

    it('offers the guest no address, only how to get their own', () => {
      const { panel } = open(null, true);

      expect(panel().getByText('Sign in with Google to get your own')).toBeVisible();
      expect(panel().queryByRole('button', { name: 'Get an address' })).toBeNull();
    });
  });

  describe('Get an address shows a new address at once, and asks the account to hold it', () => {
    it('shows the address it sends, made of letters and digits, before it is read back', async () => {
      const user = userEvent.setup();
      const { panel } = open(null);

      await user.click(panel().getByRole('button', { name: 'Get an address' }));

      expect(held.send).toHaveBeenCalledWith({
        name: 'set_email_address',
        payload: expect.objectContaining({ workspaceId: ACCOUNT_WIDE }),
      });
      const [sent] = sentParts();
      expect(emailLocalPartSchema.safeParse(sent).success).toBe(true);
      expect(shownAddress(panel())).toBe(`${sent}@${DOMAIN}`);
      expect(panel().getByRole('button', { name: 'Copy' })).toBeVisible();
    });

    it('puts back Get an address and says why where the account refuses it', async () => {
      held.send = vi.fn(() => Promise.reject(new Error('That did not reach the server.')));
      const user = userEvent.setup();
      const { panel } = open(null);

      await user.click(panel().getByRole('button', { name: 'Get an address' }));

      expect(await panel().findByRole('alert')).toHaveTextContent('That did not reach the server.');
      expect(panel().getByRole('button', { name: 'Get an address' })).toBeVisible();
    });
  });

  describe('Copy puts the whole address on the clipboard', () => {
    it('copies the address and says so', async () => {
      const user = userEvent.setup();
      const { panel } = open(HELD);

      await user.click(panel().getByRole('button', { name: 'Copy' }));

      await expect(navigator.clipboard.readText()).resolves.toBe(`${HELD}@${DOMAIN}`);
      expect(panel().getByRole('button', { name: 'Copied' })).toBeVisible();
    });
  });

  describe('Make a new address and Turn off each ask first', () => {
    it('Make a new address asks, then shows a different address and sends it', async () => {
      const user = userEvent.setup();
      const { panel } = open(HELD);

      await user.click(panel().getByRole('button', { name: 'More for Email to Cockpit' }));
      await user.click(screen.getByRole('menuitem', { name: 'Make a new address…' }));
      expect(held.send).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Make a new address' }));

      const [sent] = sentParts();
      expect(sent).not.toBe(HELD);
      expect(emailLocalPartSchema.safeParse(sent).success).toBe(true);
      expect(shownAddress(panel())).toBe(`${sent}@${DOMAIN}`);
    });

    it('Turn off asks, then offers Get an address again and sends no address', async () => {
      const user = userEvent.setup();
      const { panel, readBack } = open(HELD);

      await user.click(panel().getByRole('button', { name: 'More for Email to Cockpit' }));
      await user.click(screen.getByRole('menuitem', { name: 'Turn off' }));
      expect(held.send).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Turn off Email to Cockpit' }));

      expect(sentParts()).toEqual([null]);
      expect(panel().getByRole('button', { name: 'Get an address' })).toBeVisible();
      readBack({ domain: DOMAIN, localPart: null });
      await waitFor(() => expect(panel().getByRole('button', { name: 'Get an address' })).toBeVisible());
    });

    it.each([
      { situation: 'Make a new address…', entry: 'Make a new address…' },
      { situation: 'Turn off', entry: 'Turn off' },
    ])('sends nothing where $situation is cancelled', async ({ entry }) => {
      const user = userEvent.setup();
      const { panel } = open(HELD);

      await user.click(panel().getByRole('button', { name: 'More for Email to Cockpit' }));
      await user.click(screen.getByRole('menuitem', { name: entry }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(held.send).not.toHaveBeenCalled();
      expect(panel().getByText(`${HELD}@${DOMAIN}`)).toBeVisible();
    });
  });
});
