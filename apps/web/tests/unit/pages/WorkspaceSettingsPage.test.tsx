import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSettingsPage } from '../../../src/pages/WorkspaceSettingsPage';
import { CommandRefused } from '../../../src/api/client';
import { WORKSPACE_THEMES } from '@cockpit/shared';
import { useCommand, type CommandArgs } from '../../../src/api/queries';

/**
 * `LoadFailure` asks the world two questions it cannot answer from the error
 * alone, and asking them is a network call. F1 keeps none, so the answer is
 * given here. *Which* wording each reason gets is proved in
 * tests/unit/components/LoadFailure.test.tsx; what this file asks is which of
 * the two things the page puts on screen.
 */
vi.mock('../../../src/api/loadFailure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/loadFailure')>()),
  diagnose: () => Promise.resolve('offline' as const),
}));

/**
 * F1: what is under test is the page's own behaviour - what it asks for, what
 * it says before it asks, and what it does with an answer it does not like.
 * Whether a name is actually refused, and whether a deleted workspace really
 * goes, are the server's rules and are proved against a real database in
 * apps/api/tests/integration/http/workspace-management.test.ts; repeating them
 * here would prove nothing twice.
 */
const workspace = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea' };

/**
 * What the workspace holds, so the confirmation has something to count, and
 * how that answer arrives - a case that never lets it arrive is how "the
 * question cannot be answered until it has a count in it" is provable.
 */
const held = vi.hoisted(() => ({
  items: [] as { id: string }[],
  answer: null as null | (() => Promise<unknown>),
}));

/**
 * What the list answers with. A case sets this before rendering; the default is
 * the one workspace every other case in this file expects.
 */
const list = vi.hoisted(() => ({ answer: null as null | (() => Promise<unknown>) }));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      list.answer?.() ??
      Promise.resolve({
        workspaces: [{ id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea' }],
      }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => held.answer?.() ?? Promise.resolve({ items: held.items }),
  }),
}));

const mockUseCommand = vi.mocked(useCommand);

/**
 * The page, with a `useCommand` that answers however the case needs. `about` is
 * the change a refusal belongs to, which is what the page uses to put the
 * refusal next to the control that asked for it.
 */
function showPage(answer: {
  succeeds: boolean;
  error?: Error;
  about?: CommandArgs;
  /**
   * That the answer arrives later, so a case can send a second change while the
   * first is still in flight - which is the only way to arrange two of them
   * overlapping, and is what a real change does anyway.
   */
  answersLater?: boolean;
}) {
  const waiting: ((error: Error) => void)[] = [];
  const mutate = vi.fn(
    (
      _args: CommandArgs,
      options?: { onSuccess?: () => void; onError?: (error: Error) => void },
    ) => {
      const fail = () => options?.onError?.(answer.error ?? new Error('refused'));
      if (answer.succeeds) options?.onSuccess?.();
      else if (answer.answersLater) waiting.push(fail);
      else fail();
    },
  );
  /** Refuses everything still in flight, oldest first, as the server would. */
  const refuseEverythingSent = () => {
    for (const fail of waiting.splice(0)) fail(answer.error ?? new Error('refused'));
  };
  mockUseCommand.mockReturnValue({
    mutate,
    isPending: false,
    error: answer.error ?? null,
    variables: answer.about,
    reset: vi.fn(),
  } as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkspaceSettingsPage />
    </QueryClientProvider>,
  );
  return {
    mutate,
    refuseEverythingSent,
    box: screen.getByLabelText('Name of the new workspace'),
  };
}

const newWorkspaceButton = () => screen.getByRole('button', { name: 'New workspace' });

/**
 * What a row offers is in the row's own menu, so reaching any of it is two
 * gestures: open the menu named for the workspace, then choose the entry named
 * for the action ("Ask before deleting in a dialog, from the row's own menu",
 * issue 116).
 */
async function choose(user: ReturnType<typeof userEvent.setup>, row: string, entry: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

/**
 * Three workspaces, because one cannot be in the wrong order. Every case about
 * moving one asks for this list; every other case in the file wants the single
 * workspace the mock answers with by default.
 */
const THREE = [
  { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea' },
  { id: 'ws-atlas', tenantId: 'tenant', name: 'Atlas', color: '#3a72c8', ground: '#d8e5f7', header: '#bed6f2' },
  { id: 'ws-personal', tenantId: 'tenant', name: 'Personal', color: '#c06a45', ground: '#f2e5d4', header: '#ead2b3' },
];

function showThree() {
  list.answer = () => Promise.resolve({ workspaces: THREE });
}

/** The workspaces as the page is currently showing them, top to bottom. */
async function onScreen(): Promise<string[]> {
  const rows = await screen.findAllByRole('listitem');
  return rows.map((row) => within(row).getByRole('button', { name: /^Actions for / }).getAttribute('aria-label')!.replace('Actions for ', ''));
}

beforeEach(() => {
  list.answer = null;
  held.answer = null;
});

describe('Workspace management', () => {
  describe('making a workspace asks for the name you typed and leaves the box ready for the next one', () => {
    it('asks for the name without the blanks around it, then empties the box', async () => {
      const user = userEvent.setup();
      const { mutate, box } = showPage({ succeeds: true });

      await user.type(box, '  Bookkeeping  ');
      await user.click(newWorkspaceButton());

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'create_workspace',
        payload: { name: 'Bookkeeping' },
      });
      expect(box).toHaveValue('');
    });

    it('asks for nothing when the box holds only blanks', async () => {
      const user = userEvent.setup();
      const { mutate, box } = showPage({ succeeds: true });

      await user.type(box, '   ');
      await user.click(newWorkspaceButton());

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('the way to make a workspace stays where it is however many you have', () => {
    /**
     * The order of the two, which is what stops the way to make a workspace
     * moving down the page as the account fills up. F1 owns exactly this much
     * of it: jsdom has no layout engine and reports every width and height as
     * zero, so "and is therefore on screen" cannot be asked here at all and is
     * asserted on a real 480px screen in tests/e2e/workspace-management.test.ts.
     * What that walk cannot do is guarantee a long list - the F3 run shares one
     * database, so how many workspaces it sees depends on what ran before it -
     * which is why the order is pinned down here instead, where three of them
     * can be arranged and the answer cannot drift.
     */
    it('puts the box before the list of them', async () => {
      showThree();
      const { box } = showPage({ succeeds: true });
      await onScreen();

      const list = screen.getByRole('list');
      expect(box.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('renaming a workspace asks for the name you typed, for that workspace', () => {
    it('asks for the name without the blanks around it, then closes the box', async () => {
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });

      await choose(user, 'Work', 'Rename');
      const box = screen.getByLabelText('New name for Work');
      await user.clear(box);
      await user.type(box, '  Bookkeeping  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'rename_workspace',
        payload: { workspaceId: 'ws-work', name: 'Bookkeeping' },
      });
      expect(screen.queryByLabelText('New name for Work')).not.toBeInTheDocument();
    });

    it('starts from the name the workspace already has', async () => {
      // So changing a typo is an edit, not typing the whole name again.
      const user = userEvent.setup();
      showPage({ succeeds: true });

      await choose(user, 'Work', 'Rename');

      expect(screen.getByLabelText('New name for Work')).toHaveValue('Work');
    });

    it('asks for nothing when the box is emptied', async () => {
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });

      await choose(user, 'Work', 'Rename');
      await user.clear(screen.getByLabelText('New name for Work'));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('choosing a colour for a workspace asks for the whole theme, for that workspace', () => {
    it('asks for all three of its colours, not the one on the swatch', async () => {
      // Three, because three is what a workspace stores: the dot, the page and
      // the bar. A picker that sent only the tint would leave the page it is
      // meant to change behind.
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });
      const chosen = WORKSPACE_THEMES[4]!;

      await user.click(await screen.findByRole('button', { name: `${chosen.name} for Work` }));

      expect(mutate.mock.calls[0]![0]).toEqual({
        name: 'set_workspace_theme',
        payload: expect.objectContaining({
          workspaceId: 'ws-work',
          color: chosen.tint,
          ground: chosen.ground,
          header: chosen.header,
        }),
      });
    });

    it('shows which one the workspace is already wearing', async () => {
      // So the row says what it is, not only what it could be.
      showPage({ succeeds: true });

      const wearing = await screen.findByRole('button', { name: 'Violet for Work' });
      expect(wearing).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Teal for Work' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
  });

  describe('moving a workspace asks for the whole order, and says which one moved', () => {
    /**
     * The menu's half of moving a workspace ("Reorder workspaces", issue 31),
     * which is the half a keyboard and a phone have. The drag is the other half
     * and cannot be driven here at all - where the pointer is over the list is
     * measured from the rows' rectangles, and jsdom reports every one of them
     * as zero pixels tall in the same place - so it is walked in
     * tests/e2e/workspace-management.test.ts. What both halves compute is
     * proved in tests/unit/reorder.test.ts.
     */
    it.each([
      {
        situation: 'moved up',
        row: 'Atlas',
        entry: 'Move up',
        moved: 'ws-atlas',
        asks: ['ws-atlas', 'ws-work', 'ws-personal'],
      },
      {
        situation: 'moved down',
        row: 'Atlas',
        entry: 'Move down',
        moved: 'ws-atlas',
        asks: ['ws-work', 'ws-personal', 'ws-atlas'],
      },
      {
        situation: 'moved up from the bottom of the list',
        row: 'Personal',
        entry: 'Move up',
        moved: 'ws-personal',
        asks: ['ws-work', 'ws-personal', 'ws-atlas'],
      },
      {
        situation: 'moved down from the top of the list',
        row: 'Work',
        entry: 'Move down',
        moved: 'ws-work',
        asks: ['ws-atlas', 'ws-work', 'ws-personal'],
      },
    ])('$situation', async ({ row, entry, moved, asks }) => {
      showThree();
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });

      await choose(user, row, entry);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'reorder_workspaces',
        // The whole order, and the workspace that moved: the order alone would
        // leave the record of the change saying only that something changed.
        payload: { workspaceId: moved, workspaceIds: asks },
      });
    });

    it.each([
      { situation: 'the first workspace cannot be moved up', row: 'Work', entry: 'Move up', says: 'It is already the first' },
      { situation: 'the last workspace cannot be moved down', row: 'Personal', entry: 'Move down', says: 'It is already the last' },
    ])('$situation, and says why rather than going quiet', async ({ row, entry, says }) => {
      // Said rather than hidden, for the reason the dashboard settings page
      // says it: an entry that vanishes on one row leaves somebody hunting for
      // a control that was there a moment ago.
      showThree();
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });

      await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
      const unavailable = await screen.findByRole('menuitem', { name: `${entry}: ${says}` });
      await user.click(unavailable);

      expect(unavailable).toHaveAttribute('aria-disabled', 'true');
      expect(mutate).not.toHaveBeenCalled();
    });

    it('shows the new order before the server has agreed to it', async () => {
      // Not only so a drop does not snap back for the length of a round trip.
      // The order a second move is computed from is the order in hand, so a
      // move made before the first came back would be computed from the list
      // *before* it and would undo it.
      showThree();
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });
      expect(await onScreen()).toEqual(['Work', 'Atlas', 'Personal']);

      await choose(user, 'Personal', 'Move up');
      expect(await onScreen()).toEqual(['Work', 'Personal', 'Atlas']);
      await choose(user, 'Personal', 'Move up');

      expect(await onScreen()).toEqual(['Personal', 'Work', 'Atlas']);
      expect(mutate.mock.calls[1]![0]).toMatchObject({
        payload: { workspaceIds: ['ws-personal', 'ws-work', 'ws-atlas'] },
      });
    });
  });

  describe('you are told what deleting a workspace takes with it before it happens', () => {
    it.each([
      { situation: 'a workspace holding several items', items: 3, asks: 'Delete Work and hide its 3 items?' },
      { situation: 'a workspace holding one item', items: 1, asks: 'Delete Work and hide its 1 item?' },
      { situation: 'a workspace holding nothing', items: 0, asks: 'Delete Work? There is nothing in it.' },
    ])('$situation', async ({ items, asks }) => {
      held.items = Array.from({ length: items }, (_, i) => ({ id: `item-${i}` }));
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });

      await choose(user, 'Work', 'Delete');

      expect(await screen.findByText(asks)).toBeVisible();
      // Asked, not done: the question is the whole point of asking it.
      expect(mutate).not.toHaveBeenCalled();
    });

    it.each([
      { situation: 'answered no', answer: 'Cancel' },
      { situation: 'dismissed with Escape', answer: null },
    ])('sends nothing when the question is $situation', async ({ answer }) => {
      held.items = [{ id: 'item-0' }];
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });

      await choose(user, 'Work', 'Delete');
      await screen.findByText('Delete Work and hide its 1 item?');
      if (answer) await user.click(screen.getByRole('button', { name: answer }));
      else await user.keyboard('{Escape}');

      expect(mutate).not.toHaveBeenCalled();
      // The row is still the row, with everything it offered still on it:
      // asking never took anything off it.
      expect(screen.queryByText('Delete Work and hide its 1 item?')).toBeNull();
      expect(await screen.findByRole('button', { name: 'Actions for Work' })).toBeVisible();
    });

    it('cannot be answered yes until the count it is asking about has arrived', async () => {
      // "How many" is part of the question: an empty workspace reads as
      // harmless and a full one does not, so a question with no count in it is
      // not yet a question anybody can answer.
      held.answer = () => new Promise(() => {});
      const user = userEvent.setup();
      showPage({ succeeds: true });

      await choose(user, 'Work', 'Delete');

      expect(await screen.findByRole('button', { name: 'Yes, delete Work' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    });

    it('can be answered when the count could not be read at all', async () => {
      // A count that failed is not a reason to trap someone in the dialog.
      held.answer = () => Promise.reject(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      showPage({ succeeds: true });

      await choose(user, 'Work', 'Delete');

      await expect
        .poll(() => screen.getByRole('button', { name: 'Yes, delete Work' }))
        .toBeEnabled();
    });

    it('asks for the workspace to be deleted when the question is answered yes', async () => {
      held.items = [];
      const user = userEvent.setup();
      const { mutate } = showPage({ succeeds: true });

      await choose(user, 'Work', 'Delete');
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Work' }));

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]![0]).toMatchObject({
        name: 'delete_workspace',
        payload: { workspaceId: 'ws-work' },
      });
    });
  });

  describe('a change to a workspace that failed puts the screen back', () => {
    it.each([
      {
        situation: 'the name a new workspace was given is already another’s',
        error: new CommandRefused(409, 'a workspace called Work already exists'),
        about: {
          name: 'create_workspace',
          payload: { commandId: 'c', issuedAt: 'now', workspaceId: 'ws-new', name: 'Work' },
        },
        says: 'a workspace called Work already exists',
      },
      {
        situation: 'the request never reached the server',
        error: new Error('Failed to fetch'),
        about: {
          name: 'create_workspace',
          payload: { commandId: 'c', issuedAt: 'now', workspaceId: 'ws-new', name: 'Work' },
        },
        says: 'That did not reach the server. Try again.',
      },
    ] as { situation: string; error: Error; about: CommandArgs; says: string }[])(
      '$situation',
      async ({ error, about, says }) => {
        const user = userEvent.setup();
        const { box } = showPage({ succeeds: false, error, about });

        await user.type(box, 'Work');
        await user.click(newWorkspaceButton());

        expect(screen.getByRole('alert')).toHaveTextContent(says);
        // Still there to be corrected, rather than typed again from nothing.
        expect(box).toHaveValue('Work');
      },
    );

    it('says why a rename was refused, next to the name that was refused', async () => {
      const user = userEvent.setup();
      showPage({
        succeeds: false,
        error: new CommandRefused(409, 'a workspace called Personal already exists'),
        about: {
          name: 'rename_workspace',
          payload: { commandId: 'c', issuedAt: 'now', workspaceId: 'ws-work', name: 'Personal' },
        },
      });

      await choose(user, 'Work', 'Rename');
      const box = screen.getByLabelText('New name for Work');
      await user.clear(box);
      await user.type(box, 'Personal');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // In the row, not merely somewhere on the page: a refusal at the bottom
      // of the settings page next to the box for making a *new* workspace
      // reads as being about that box.
      expect(within(screen.getByRole('listitem')).getByRole('alert')).toHaveTextContent(
        'a workspace called Personal already exists',
      );
      expect(box).toHaveValue('Personal');
    });

    it('says why a delete was refused in the question that asked for it, which stays open', async () => {
      // A dialog that closed and left the message behind on the page would
      // make a refusal look like a delete that had worked.
      held.items = [];
      const user = userEvent.setup();
      showPage({
        succeeds: false,
        error: new CommandRefused(404, 'that workspace is not there'),
        about: {
          name: 'delete_workspace',
          payload: { commandId: 'c', issuedAt: 'now', workspaceId: 'ws-work' },
        },
      });

      await choose(user, 'Work', 'Delete');
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Work' }));

      expect(screen.getByRole('alert')).toHaveTextContent('that workspace is not there');
      expect(screen.getByText('Delete Work? There is nothing in it.')).toBeVisible();
      expect(screen.getByText('Work')).toBeVisible();
    });

    it('puts a refused move back where it was, and says why next to the workspace that moved', async () => {
      // The one change on this page that shows itself before the server has
      // agreed, so it is the one that has to undo itself. Without the message
      // the row simply reappears where it started, which reads as the move
      // having missed rather than having been refused.
      showThree();
      const user = userEvent.setup();
      showPage({
        succeeds: false,
        error: new CommandRefused(409, 'the workspaces changed while they were being put in order'),
        about: {
          name: 'reorder_workspaces',
          payload: {
            commandId: 'c',
            issuedAt: 'now',
            workspaceId: 'ws-personal',
            workspaceIds: ['ws-work', 'ws-personal', 'ws-atlas'],
          },
        },
      });

      await choose(user, 'Personal', 'Move up');

      expect(await onScreen()).toEqual(['Work', 'Atlas', 'Personal']);
      const row = (await screen.findAllByRole('listitem')).at(-1)!;
      expect(within(row).getByRole('alert')).toHaveTextContent(
        'the workspaces changed while they were being put in order',
      );
    });

    it('puts a move that never reached the server back, without asking the server where it was', async () => {
      // The half re-reading the list cannot do. A move that failed because
      // nothing could be reached fails a re-read for the same reason, so the
      // only answer left is the copy the page was holding before it moved
      // anything - and without it the order stays showing a move that never
      // happened.
      let asked = 0;
      list.answer = () => {
        asked += 1;
        return asked === 1
          ? Promise.resolve({ workspaces: THREE })
          : Promise.reject(new TypeError('Failed to fetch'));
      };
      const user = userEvent.setup();
      showPage({
        succeeds: false,
        error: new Error('Failed to fetch'),
        about: {
          name: 'reorder_workspaces',
          payload: {
            commandId: 'c',
            issuedAt: 'now',
            workspaceId: 'ws-personal',
            workspaceIds: ['ws-work', 'ws-personal', 'ws-atlas'],
          },
        },
      });

      await choose(user, 'Personal', 'Move up');

      await expect.poll(onScreen).toEqual(['Work', 'Atlas', 'Personal']);
      expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent(
        'That did not reach the server. Try again.',
      );
    });

    it('shows what the account holds after two moves made before either was answered', async () => {
      // The half putting the copy in hand back cannot do. Each move is holding
      // the order from before *itself*, so the second one's copy already has
      // the first one's move in it - and whichever refusal happens to land last
      // would otherwise leave the page showing an order the account never had.
      // Only asking the server settles it.
      showThree();
      const user = userEvent.setup();
      const { refuseEverythingSent } = showPage({
        succeeds: false,
        answersLater: true,
        error: new CommandRefused(409, 'the workspaces changed while they were being put in order'),
        about: {
          name: 'reorder_workspaces',
          payload: {
            commandId: 'c',
            issuedAt: 'now',
            workspaceId: 'ws-personal',
            workspaceIds: ['ws-personal', 'ws-work', 'ws-atlas'],
          },
        },
      });

      await choose(user, 'Personal', 'Move up');
      await choose(user, 'Personal', 'Move up');
      expect(await onScreen()).toEqual(['Personal', 'Work', 'Atlas']);

      refuseEverythingSent();

      await expect.poll(onScreen).toEqual(['Work', 'Atlas', 'Personal']);
    });

    it('says why a colour was refused, next to the workspace it was for', async () => {
      const user = userEvent.setup();
      const chosen = WORKSPACE_THEMES[5]!;
      showPage({
        succeeds: false,
        error: new CommandRefused(400, 'that is not one of the themes'),
        about: {
          name: 'set_workspace_theme',
          payload: {
            commandId: 'c',
            issuedAt: 'now',
            workspaceId: 'ws-work',
            color: chosen.tint,
            ground: chosen.ground,
            header: chosen.header,
          },
        },
      });

      await user.click(await screen.findByRole('button', { name: `${chosen.name} for Work` }));

      expect(within(screen.getByRole('listitem')).getByRole('alert')).toHaveTextContent(
        'that is not one of the themes',
      );
      // The swatches are still there to try another one; nothing was taken away
      // because a colour was refused.
      expect(screen.getByRole('button', { name: `${chosen.name} for Work` })).toBeVisible();
    });
  });

  describe('the workspaces you have are listed', () => {
    it('shows each one by name', async () => {
      showPage({ succeeds: true });

      expect(await screen.findByText(workspace.name)).toBeVisible();
    });
  });
});

describe('Workspace management', () => {
  describe('a list of workspaces that could not be loaded says so, rather than that there are none', () => {
    it('says what went wrong when the list could not be read', async () => {
      list.answer = () => Promise.reject(new TypeError('Failed to fetch'));

      showPage({ succeeds: true });

      expect(await screen.findByRole('alert')).toHaveTextContent("Cockpit can't be reached");
      // The lie this rule exists to stop: an account whose list did not arrive
      // is not an account with nothing in it.
      expect(screen.queryByText(/No workspaces yet/)).not.toBeInTheDocument();
    });

    it('says nothing about how many there are while it is still asking', async () => {
      // Found by running the app rather than by this file: keyed on the error
      // alone, a query that is still retrying has no error yet, so the page
      // went on claiming the account was empty for as long as the retries
      // lasted. An answer has to have arrived before either message is true.
      list.answer = () => new Promise(() => {});

      showPage({ succeeds: true });

      expect(screen.queryByText(/No workspaces yet/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says there are none when the list arrived and was empty', async () => {
      list.answer = () => Promise.resolve({ workspaces: [] });

      showPage({ succeeds: true });

      expect(await screen.findByText(/No workspaces yet/)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
