import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ITEM_TYPE_COLORS } from '@cockpit/shared';
import { ItemTypeSettingsPage } from '../../../src/pages/ItemTypeSettingsPage';
import { CommandRefused } from '../../../src/api/client';
import { useCommand, type CommandArgs } from '../../../src/api/queries';

vi.mock('../../../src/api/loadFailure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/loadFailure')>()),
  diagnose: () => Promise.resolve('offline' as const),
}));

/**
 * F1: what is under test is the page's own behaviour - what it lists, what it
 * asks for, and what it does with an answer it does not like. Whether a name is
 * actually refused and whether a deleted type really goes are the server's
 * rules, proved against a real store in
 * apps/api/tests/integration/http/item-types.test.ts.
 */
const ACTION = {
  id: 'type-action',
  tenantId: 'tenant',
  name: 'Action',
  color: ITEM_TYPE_COLORS[0]!,
  position: 0,
  createdAt: '2026-09-04T10:00:00.000Z',
};
const THOUGHT = { ...ACTION, id: 'type-thought', name: 'Thought', color: ITEM_TYPE_COLORS[1]!, position: 1 };
const QUESTION = { ...ACTION, id: 'type-question', name: 'Question', color: ITEM_TYPE_COLORS[2]!, position: 2 };

/** What the list answers with, and what the items of each workspace are. */
const held = vi.hoisted(() => ({
  types: null as null | unknown[],
  answer: null as null | (() => Promise<unknown>),
  itemsByWorkspace: {} as Record<string, { id: string; typeId: string | null }[]>,
  workspaces: [{ id: 'ws-work' }] as { id: string }[],
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  itemTypesQuery: {
    queryKey: ['itemTypes'],
    queryFn: () => held.answer?.() ?? Promise.resolve({ itemTypes: held.types ?? [] }),
  },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => Promise.resolve({ workspaces: held.workspaces }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: held.itemsByWorkspace[workspaceId] ?? [] }),
  }),
}));

const mockUseCommand = vi.mocked(useCommand);

function showPage(answer: {
  succeeds: boolean;
  error?: Error;
  about?: CommandArgs;
} = { succeeds: true }) {
  const mutate = vi.fn(
    (
      _args: CommandArgs,
      options?: { onSuccess?: () => void; onError?: (error: Error) => void },
    ) => {
      if (answer.succeeds) options?.onSuccess?.();
      else options?.onError?.(answer.error ?? new Error('refused'));
    },
  );
  mockUseCommand.mockReturnValue({
    mutate,
    isPending: false,
    error: answer.error ?? null,
    variables: answer.about,
    reset: vi.fn(),
  } as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ItemTypeSettingsPage />
    </QueryClientProvider>,
  );
  return { mutate };
}

async function choose(user: ReturnType<typeof userEvent.setup>, row: string, entry: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

/** The types as the page is currently showing them, top to bottom. */
const asShown = () =>
  screen
    .getAllByRole('button', { name: /^Actions for / })
    .map((control) => control.getAttribute('aria-label')!.replace('Actions for ', ''));

beforeEach(() => {
  held.types = [ACTION, THOUGHT, QUESTION];
  held.answer = null;
  held.itemsByWorkspace = {};
  held.workspaces = [{ id: 'ws-work' }];
});

describe('Capture', () => {
  describe('the types page lists every type of the account', () => {
    it.each([
      { situation: 'none', types: [] as unknown[], shows: [] as string[] },
      { situation: 'one', types: [ACTION], shows: ['Action'] },
      { situation: 'several', types: [ACTION, THOUGHT, QUESTION], shows: ['Action', 'Thought', 'Question'] },
    ])('$situation', async ({ types, shows }) => {
      held.types = types;
      showPage();

      if (shows.length === 0) {
        expect(await screen.findByText(/No types yet/)).toBeVisible();
      } else {
        await screen.findByRole('button', { name: `Actions for ${shows[0]}` });
        expect(asShown()).toEqual(shows);
      }
    });

    it('says nothing about an account whose types have not arrived', async () => {
      held.answer = () => Promise.reject(new Error('offline'));
      showPage();

      expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
      expect(screen.queryByText(/No types yet/)).toBeNull();
    });
  });

  describe('changing a type here changes it wherever it is shown', () => {
    it('asks for the new name, for that row’s own type', async () => {
      const user = userEvent.setup();
      const { mutate } = showPage();

      await choose(user, 'Thought', 'Rename');
      await user.clear(screen.getByLabelText('New name for Thought'));
      await user.type(screen.getByLabelText('New name for Thought'), '  Idea  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'rename_item_type',
        payload: { typeId: 'type-thought', name: 'Idea' },
      });
    });

    it('asks for the colour picked, for that row’s own type', async () => {
      const user = userEvent.setup();
      const { mutate } = showPage();

      await user.click(
        await screen.findByRole('button', { name: `${ITEM_TYPE_COLORS[4]} for Thought` }),
      );

      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'set_item_type_color',
        payload: { typeId: 'type-thought', color: ITEM_TYPE_COLORS[4] },
      });
    });

    it('leaves what was typed where it is when the new name is refused', async () => {
      const user = userEvent.setup();
      showPage({
        succeeds: false,
        error: new CommandRefused(409, 'a type called Action already exists'),
        about: {
          name: 'rename_item_type',
          payload: { typeId: 'type-thought' },
        } as unknown as CommandArgs,
      });

      await choose(user, 'Thought', 'Rename');
      await user.clear(screen.getByLabelText('New name for Thought'));
      await user.type(screen.getByLabelText('New name for Thought'), 'Action');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(screen.getByLabelText('New name for Thought')).toHaveValue('Action');
    });
  });

  describe('deleting a type asks first and says what it takes with it', () => {
    it.each([
      { situation: 'nothing is of this type', items: {}, says: /Nothing is of this type/ },
      {
        situation: 'items in one workspace are',
        items: { 'ws-work': [{ id: 'i1', typeId: 'type-thought' }] },
        says: /1 item will stop having a type/,
      },
      {
        situation: 'items in several workspaces are',
        items: {
          'ws-work': [{ id: 'i1', typeId: 'type-thought' }],
          'ws-home': [
            { id: 'i2', typeId: 'type-thought' },
            { id: 'i3', typeId: 'type-thought' },
          ],
        },
        says: /3 items across 2 workspaces will stop having a type/,
      },
    ])('$situation', async ({ items, says }) => {
      held.itemsByWorkspace = items;
      held.workspaces = Object.keys(items).length ? Object.keys(items).map((id) => ({ id })) : [{ id: 'ws-work' }];
      const user = userEvent.setup();
      showPage();

      await choose(user, 'Thought', 'Delete');

      const dialog = await screen.findByRole('alertdialog');
      expect(await within(dialog).findByText(says)).toBeVisible();
    });

    it('sends nothing until the question is answered, then sends the delete', async () => {
      const user = userEvent.setup();
      const { mutate } = showPage();

      await choose(user, 'Thought', 'Delete');
      expect(mutate).not.toHaveBeenCalled();

      await user.click(
        await screen.findByRole('button', { name: 'Yes, delete Thought' }),
      );

      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'delete_item_type',
        payload: { typeId: 'type-thought' },
      });
    });
  });

  describe('the types are in the order you put them in, and the two ways are one move', () => {
    it.each([
      { situation: 'moved up from the menu', row: 'Thought', entry: 'Move up', order: ['type-thought', 'type-action', 'type-question'] },
      { situation: 'moved down from the menu', row: 'Thought', entry: 'Move down', order: ['type-action', 'type-question', 'type-thought'] },
    ])('$situation', async ({ row, entry, order }) => {
      const user = userEvent.setup();
      const { mutate } = showPage();

      await choose(user, row, entry);

      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'reorder_item_types',
        payload: { typeId: 'type-thought', typeIds: order },
      });
    });

    it.each([
      { situation: 'the first row', row: 'Action', entry: 'Move up', says: 'It is already the first' },
      { situation: 'the last row', row: 'Question', entry: 'Move down', says: 'It is already the last' },
    ])('says why it cannot move from $situation, rather than going quiet', async ({ row, entry, says }) => {
      const user = userEvent.setup();
      const { mutate } = showPage();

      await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
      const stuck = await screen.findByRole('menuitem', { name: `${entry}: ${says}` });

      expect(stuck).toBeVisible();
      await user.click(stuck);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('shows the move before the server agrees', async () => {
      const user = userEvent.setup();
      showPage();

      await choose(user, 'Thought', 'Move up');

      // The list is painted moved, without a second answer having arrived.
      expect(asShown()).toEqual(['Thought', 'Action', 'Question']);
    });

    it('puts the row back and says why when the move is refused', async () => {
      const user = userEvent.setup();
      showPage({
        succeeds: false,
        error: new CommandRefused(409, 'the types changed while they were being put in order'),
        about: {
          name: 'reorder_item_types',
          payload: { typeId: 'type-thought' },
        } as unknown as CommandArgs,
      });

      await choose(user, 'Thought', 'Move up');

      expect(asShown()).toEqual(['Action', 'Thought', 'Question']);
      expect(
        await screen.findByText('the types changed while they were being put in order'),
      ).toBeVisible();
    });
  });
});
