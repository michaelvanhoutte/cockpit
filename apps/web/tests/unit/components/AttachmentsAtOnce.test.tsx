import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Attachment, CommandResult, Item, WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, attachmentUrl, fetchSnapshot, fetchWorkspaces, sendCommand, uploadAttachment } from '../../../src/api/client';
import { ItemForm } from '../../../src/components/ItemForm';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A file attached to an Item, and one removed, as the form draws them with the
 * server holding the answer - the frontend-with-its-own-backend level (F2), run in
 * this runner as `ChangesAtOnce.test.tsx` is. The form, the queries and the tab's
 * queue are the app's own and only the network is replaced: a server that answers
 * an upload or a change when the test says, keeps what it was told, and answers a
 * read with what it held when the read began. When a file stops being drawn is
 * tests/unit/changeQueue.test.ts and what it draws is tests/unit/drawnAhead.test.ts;
 * what is asked here is that the form is wired to them.
 */

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchWorkspaces: vi.fn(),
  sendCommand: vi.fn(),
  uploadAttachment: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => vi.fn(() => Promise.resolve()),
  useParams: () => ({ workspaceId: 'ws-work' }),
}));

vi.mock('../../../src/itemForm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/itemForm')>()),
  useReportDocked: () => () => {},
  useQuietOpening: () => () => false,
  useSettleQuietOpening: () => () => {},
  useItemForm: () => ({ openItemId: BART, close: vi.fn() }),
  useOpenItem: () => () => {},
}));

/** The description's editor, as a box that takes text. */
vi.mock('../../../src/description/RichDescription', () => ({
  default: function FakeRichDescription({ initial, onChange }: { initial: string; onChange: (markdown: string) => void }) {
    const [value, setValue] = useState(initial);
    return (
      <textarea
        aria-label="Description"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
      />
    );
  },
}));

const BART = 'item-bart';
const SCAN = '11111111-1111-7111-8111-0000000000a1';

const anItem = (): Item =>
  ({
    id: BART,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    title: 'Reply to Bart',
    description: null,
    capturedMessage: null,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:00:00.000Z',
  }) as unknown as Item;

const aServerAttachment = (id: string, filename: string): Attachment => ({
  id,
  tenantId: 'tenant',
  itemId: BART,
  filename,
  size: 5,
  contentType: 'application/pdf',
  createdAt: '2026-10-19T08:00:00.000Z',
});

/** The files the server holds on the Item. */
let stored: Attachment[];

/** Every upload and every change the server has been sent and not yet answered, oldest first. */
let uploads: { filename: string; store: () => void; answer: () => void; refuse: (error: Error) => void }[];
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** While set, a read of the Workspace is held until `releaseReads` lets it go; it answers with what the server held when it began. */
let holdingReads: boolean;
let held: (() => void)[];

let client: QueryClient;

function theWorkspace(): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: [anItem()],
    dashboards: [],
    panels: [],
    layouts: [],
    associations: [],
    attachments: stored,
    itemFormPresentation: 'centered',
    followUpDays: 3,
    duplicates: [],
    filings: [],
    agentRuns: [],
    generatedAt: '2026-10-20T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

const aFile = () => new File(['bytes'], 'scan.pdf', { type: 'application/pdf' });

async function show(attached: Attachment[] = []) {
  stored = attached;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <ItemForm />
      </UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  await screen.findByLabelText('Title');
  return userEvent.setup();
}

const choose = (user: ReturnType<typeof userEvent.setup>) => user.upload(screen.getByLabelText('Files to attach'), aFile());

/** The files that can be opened from the Item tab's line. */
const chips = () => screen.queryAllByRole('link', { name: /scan\.pdf/ });

/** The Attachments tab opened, and its list to look inside. */
const theAttachmentsTab = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: /^Attachments/ }));
  return within(screen.getByRole('tabpanel', { name: /^Attachments/ }));
};

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const releaseReads = () => act(async () => held.splice(0).forEach((release) => release()));
const answerUpload = async () => {
  await act(async () => uploads.shift()!.answer());
  await settle();
};

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  uploads = [];
  waiting = [];
  held = [];
  holdingReads = false;
  vi.mocked(fetchSnapshot).mockReset();
  vi.mocked(fetchSnapshot).mockImplementation(async () => {
    const asItWas = structuredClone(theWorkspace());
    if (holdingReads) await new Promise<void>((release) => held.push(release));
    return asItWas;
  });
  vi.mocked(fetchWorkspaces).mockResolvedValue({ workspaces: [] } as never);
  vi.mocked(uploadAttachment).mockReset();
  vi.mocked(uploadAttachment).mockImplementation(
    ({ attachmentId, file }) =>
      new Promise<CommandResult>((resolve, reject) => {
        let isStored = false;
        const store = () => {
          if (!isStored) stored = [...stored, aServerAttachment(attachmentId, file.name)];
          isStored = true;
        };
        uploads.push({
          filename: file.name,
          store,
          answer: () => {
            store();
            resolve({ ok: true, applied: true, at: '2026-10-21T10:00:00.000Z' });
          },
          refuse: reject,
        });
      }),
  );
  vi.mocked(sendCommand).mockReset();
  vi.mocked(sendCommand).mockImplementation(
    (name, payload) =>
      new Promise<CommandResult>((resolve, reject) => {
        waiting.push({
          name,
          payload: payload as Record<string, unknown>,
          answer: () => {
            const gone = (payload as { attachmentId: string }).attachmentId;
            if (name === 'remove_attachment') stored = stored.filter((held) => held.id !== gone);
            resolve({ ok: true, applied: true, at: '2026-10-21T10:00:01.000Z' });
          },
          refuse: reject,
        });
      }),
  );
});

afterEach(async () => {
  cleanup();
  resetStanding();
  for (let round = 0; round < 6 && changes.unanswered() > 0; round += 1) {
    await act(async () => waiting.splice(0).forEach((request) => request.answer()));
    await settle();
  }
  changes.forgetAnswered();
});

describe('Item editing', () => {
  describe('a file is drawn from the moment it is chosen, until a read that began after its upload was answered has landed', () => {
    it('shows Attaching… while it uploads, then its chip, which opens the file, with the read for it still on its way', async () => {
      const user = await show();

      await choose(user);

      expect(screen.getByText('Attaching…')).toBeVisible();
      expect(chips()).toHaveLength(0);

      holdingReads = true;
      await answerUpload();

      expect(screen.queryByText('Attaching…')).toBeNull();
      expect(chips()).toHaveLength(1);
      expect(chips()[0]).toHaveAttribute('href', attachmentUrl(stored[0]!.id));
      // The read behind the answer is on its way and has not come back.
      expect(held).toHaveLength(1);
    });

    it('keeps the chip under a read that began before the answer and does not hold the file', async () => {
      const user = await show();
      await choose(user);
      holdingReads = true;
      await act(async () => void client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'] }));
      await waitFor(() => expect(held).toHaveLength(1));

      await answerUpload();
      // The read that began first comes back without the file.
      await act(async () => held.shift()!());
      await settle();

      expect(chips()).toHaveLength(1);
    });

    it('draws the chip once under a read that began before the answer and already holds the file', async () => {
      const user = await show();
      await choose(user);
      // The server has stored the file; its answer has not reached the tab, and a read begins meanwhile.
      uploads[0]!.store();
      holdingReads = true;
      await act(async () => void client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'] }));
      await waitFor(() => expect(held).toHaveLength(1));

      await answerUpload();
      await act(async () => held.shift()!());
      await settle();

      expect(chips()).toHaveLength(1);
    });
    it('shows the server’s chip, once, when a read that began after the answer has landed', async () => {
      const user = await show();
      await choose(user);
      holdingReads = true;
      await answerUpload();
      expect(chips()).toHaveLength(1);

      await releaseReads();

      await waitFor(() => expect(held).toHaveLength(0));
      expect(chips()).toHaveLength(1);
      // The copy the screen draws now is the server’s, with nothing drawn over it.
      expect(changes.drawnOver(client.getQueryData(['snapshot', 'ws-work']) as WorkspaceSnapshot).attachments).toEqual(stored);
    });
  });

  describe('a file the server refuses leaves, and the server’s words show under the files', () => {
    it('takes Attaching… away and says why when the upload is refused as too large', async () => {
      const user = await show();
      await choose(user);
      expect(screen.getByText('Attaching…')).toBeVisible();

      await act(async () => uploads.shift()!.refuse(new CommandRefused(413, 'an attachment may be at most 26214400 bytes')));
      await settle();

      expect(screen.queryByText('Attaching…')).toBeNull();
      expect(chips()).toHaveLength(0);
      expect(screen.getByText('an attachment may be at most 26214400 bytes')).toBeVisible();
    });
  });

  describe('removing an attachment takes its chip away at once, with the server still holding the answer', () => {
    it('shows the chip gone, and sends the removal', async () => {
      const user = await show([aServerAttachment(SCAN, 'scan.pdf')]);
      const list = await theAttachmentsTab(user);
      expect(list.queryAllByRole('link', { name: /scan\.pdf/ })).toHaveLength(1);

      await user.click(list.getByRole('button', { name: 'Remove scan.pdf' }));

      expect(list.queryAllByRole('link', { name: /scan\.pdf/ })).toHaveLength(0);
      expect(chips()).toHaveLength(0);
      expect(waiting.map((request) => request.name)).toEqual(['remove_attachment']);
      expect(waiting[0]!.payload).toMatchObject({ itemId: BART, attachmentId: SCAN });
    });

    it('brings the chip back and says why under the files when the removal is refused', async () => {
      const user = await show([aServerAttachment(SCAN, 'scan.pdf')]);
      const list = await theAttachmentsTab(user);
      await user.click(list.getByRole('button', { name: 'Remove scan.pdf' }));
      expect(list.queryAllByRole('link', { name: /scan\.pdf/ })).toHaveLength(0);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That item is locked.')));
      await settle();

      expect(list.getAllByRole('link', { name: /scan\.pdf/ })).toHaveLength(1);
      expect(list.getByText('That item is locked.')).toBeVisible();
    });
  });
});
