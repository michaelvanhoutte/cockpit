import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Attachment, CommandResult, Item, WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchSnapshot, fetchWorkspaces, sendCommand, uploadAttachment, uploadThumbnail } from '../../../src/api/client';
import { ThumbnailUnreadable, makeThumbnailCopy } from '../../../src/thumbnailCopy';
import { ItemForm } from '../../../src/components/ItemForm';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * Which picture stands for an Item, as the Attachments tab offers and draws it
 * with the server holding the answer ("Item form: there is no way to mark which
 * image stands for an Item", issue 1863) - run in this runner as
 * `AttachmentsAtOnce.test.tsx` is. The form, the queries and the tab's queue
 * are the app's own and only the network and the canvas are replaced.
 */

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchWorkspaces: vi.fn(),
  sendCommand: vi.fn(),
  uploadAttachment: vi.fn(),
  uploadThumbnail: vi.fn(),
}));

/** jsdom has no canvas: the small copy is a few bytes of the type a browser would make. */
vi.mock('../../../src/thumbnailCopy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/thumbnailCopy')>()),
  makeThumbnailCopy: vi.fn(async () => new Blob(['copy'], { type: 'image/webp' })),
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
const FRONT = '11111111-1111-7111-8111-0000000000a1';
const SIDE = '11111111-1111-7111-8111-0000000000a2';
const SCAN = '11111111-1111-7111-8111-0000000000a3';
const CLIP = '11111111-1111-7111-8111-0000000000a4';
const NOTES = '11111111-1111-7111-8111-0000000000a5';

const aFile = (id: string, filename: string, contentType: string): Attachment => ({
  id,
  tenantId: 'tenant',
  itemId: BART,
  filename,
  size: 5,
  contentType,
  createdAt: '2026-10-19T08:00:00.000Z',
});

/** What the server holds: the Item's files and which of them stands for it. */
let stored: Attachment[];
let thumbnail: string | null;

/** The picks and the changes the server has been sent and not yet answered, oldest first. */
let picks: { attachmentId: string; answer: () => void; refuse: (error: Error) => void }[];
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];
let uploads: { answer: () => void }[];

let client: QueryClient;

function theWorkspace(): WorkspaceSnapshot {
  const item = {
    id: BART,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    title: 'Anna (main character)',
    description: null,
    capturedMessage: null,
    thumbnailAttachmentId: thumbnail,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:00:00.000Z',
  } as unknown as Item;
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: [item],
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

async function show(files: Attachment[], picked: string | null = null) {
  stored = files;
  thumbnail = picked;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <ItemForm />
      </UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  await screen.findByLabelText('Title');
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /^Attachments/ }));
  return { user, tab: within(screen.getByRole('tabpanel', { name: /^Attachments/ })) };
}

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

const TWO_IMAGES = () => [aFile(FRONT, 'front.jpg', 'image/jpeg'), aFile(SIDE, 'side.png', 'image/png')];

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  picks = [];
  waiting = [];
  uploads = [];
  vi.mocked(fetchSnapshot).mockReset();
  vi.mocked(fetchSnapshot).mockImplementation(async () => structuredClone(theWorkspace()));
  vi.mocked(fetchWorkspaces).mockResolvedValue({ workspaces: [] } as never);
  vi.mocked(uploadAttachment).mockReset();
  vi.mocked(uploadAttachment).mockImplementation(
    () => new Promise<CommandResult>((resolve) => uploads.push({ answer: () => resolve({ ok: true, applied: true, at: '2026-10-21T10:00:00.000Z' }) })),
  );
  vi.mocked(uploadThumbnail).mockReset();
  vi.mocked(uploadThumbnail).mockImplementation(
    ({ attachmentId }) =>
      new Promise<CommandResult>((resolve, reject) => {
        picks.push({
          attachmentId,
          answer: () => {
            thumbnail = attachmentId;
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
            if (name === 'set_thumbnail') thumbnail = (payload as { attachmentId: string | null }).attachmentId;
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
    await act(async () => {
      waiting.splice(0).forEach((request) => request.answer());
      picks.splice(0).forEach((request) => request.answer());
    });
    await settle();
  }
  changes.forgetAnswered();
});

describe('Item editing', () => {
  describe('the Attachments tab offers Use as thumbnail on each picture that is not the thumbnail, and Thumbnail on the one that is', () => {
    it('offers Use as thumbnail on both pictures while none is picked', async () => {
      const { tab } = await show(TWO_IMAGES());

      expect(tab.getAllByRole('button', { name: 'Use as thumbnail' })).toHaveLength(2);
      expect(tab.queryByRole('button', { name: 'Thumbnail' })).toBeNull();
    });

    it('shows the picked one as Thumbnail, the other still offering Use as thumbnail, and offers Stop using when the tag is pressed', async () => {
      const { user, tab } = await show(TWO_IMAGES(), FRONT);

      expect(tab.getAllByRole('button', { name: 'Use as thumbnail' })).toHaveLength(1);
      expect(tab.getByRole('button', { name: 'Thumbnail' })).toBeVisible();
      expect(tab.queryByRole('button', { name: 'Stop using as thumbnail' })).toBeNull();

      await user.click(tab.getByRole('button', { name: 'Thumbnail' }));

      expect(tab.getByRole('button', { name: 'Stop using as thumbnail' })).toBeVisible();
      expect(tab.queryByRole('button', { name: 'Thumbnail' })).toBeNull();
    });

    it('offers nothing on a PDF, a clip or a text file', async () => {
      const { tab } = await show([aFile(SCAN, 'scan.pdf', 'application/pdf'), aFile(CLIP, 'voice.mp4', 'video/mp4'), aFile(NOTES, 'notes.txt', 'text/plain')]);

      expect(tab.getAllByRole('link')).toHaveLength(3);
      expect(tab.queryByRole('button', { name: /thumbnail/i })).toBeNull();
    });

    it('offers nothing on a picture still Attaching…, and offers it once uploaded', async () => {
      const { user, tab } = await show([]);
      await user.upload(screen.getByLabelText('Files to attach'), new File(['bytes'], 'front.jpg', { type: 'image/jpeg' }));
      expect(tab.getByText('Attaching…')).toBeVisible();
      expect(tab.queryByRole('button', { name: 'Use as thumbnail' })).toBeNull();

      stored = [aFile(FRONT, 'front.jpg', 'image/jpeg')];
      await act(async () => uploads.shift()!.answer());
      await settle();

      expect(tab.queryByText('Attaching…')).toBeNull();
      expect(tab.getByRole('button', { name: 'Use as thumbnail' })).toBeVisible();
    });
  });

  describe('a pick is drawn at once, and a refusal puts it back and says why', () => {
    it('moves the tag to the picture picked before the server has answered, and sends its small copy', async () => {
      const { user, tab } = await show(TWO_IMAGES(), FRONT);

      await user.click(tab.getByRole('button', { name: 'Use as thumbnail' }));

      // Drawn at once: the tag is on the other picture while the upload is still out.
      await waitFor(() => expect(picks).toHaveLength(1));
      expect(picks[0]!.attachmentId).toBe(SIDE);
      const [front, side] = tab.getAllByRole('link').map((link) => link.closest('div')!.parentElement!);
      expect(within(side!).getByRole('button', { name: 'Thumbnail' })).toBeVisible();
      expect(within(front!).getByRole('button', { name: 'Use as thumbnail' })).toBeVisible();
    });

    it('puts the tag back and says why in the undo bar when the pick is refused', async () => {
      const { user, tab } = await show(TWO_IMAGES(), FRONT);
      await user.click(tab.getByRole('button', { name: 'Use as thumbnail' }));
      await waitFor(() => expect(picks).toHaveLength(1));

      await act(async () => picks.shift()!.refuse(new CommandRefused(404, `attachment ${SIDE} not found`)));
      await settle();

      expect(tab.getAllByRole('button', { name: 'Use as thumbnail' })).toHaveLength(1);
      expect(tab.getByRole('button', { name: 'Thumbnail' })).toBeVisible();
      expect(screen.getByText(/The thumbnail was not changed\./)).toHaveTextContent(`attachment ${SIDE} not found`);
    });

    it('puts the tag back and says the copy’s own reason when the small copy cannot be made', async () => {
      vi.mocked(makeThumbnailCopy).mockRejectedValueOnce(new ThumbnailUnreadable());
      const { user, tab } = await show(TWO_IMAGES(), FRONT);

      await user.click(tab.getByRole('button', { name: 'Use as thumbnail' }));
      await settle();

      expect(picks).toHaveLength(0);
      expect(tab.getByRole('button', { name: 'Thumbnail' })).toBeVisible();
      expect(screen.getByText(/The thumbnail was not changed\./)).toHaveTextContent('That picture could not be read');
      expect(screen.queryByText(/did not reach the server/)).toBeNull();
    });

    it('says the pick did not reach the server when the picture’s load drops, not that it could not be read', async () => {
      vi.mocked(makeThumbnailCopy).mockRejectedValueOnce(new TypeError('network'));
      const { user, tab } = await show(TWO_IMAGES(), FRONT);

      await user.click(tab.getByRole('button', { name: 'Use as thumbnail' }));
      await settle();

      expect(tab.getByRole('button', { name: 'Thumbnail' })).toBeVisible();
      expect(screen.getByText(/The thumbnail was not changed\./)).toHaveTextContent('That did not reach the server. Try again.');
    });

    it('takes the tag away at once on Stop using, and brings it back saying why when that is refused', async () => {
      const { user, tab } = await show(TWO_IMAGES(), FRONT);
      await user.click(tab.getByRole('button', { name: 'Thumbnail' }));

      await user.click(tab.getByRole('button', { name: 'Stop using as thumbnail' }));

      expect(tab.getAllByRole('button', { name: 'Use as thumbnail' })).toHaveLength(2);
      expect(waiting.map((request) => request.name)).toEqual(['set_thumbnail']);
      expect(waiting[0]!.payload).toMatchObject({ itemId: BART, attachmentId: null });

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That item is locked.')));
      await settle();

      expect(tab.getByRole('button', { name: 'Thumbnail' })).toBeVisible();
      expect(screen.getByText(/The thumbnail was not changed\./)).toHaveTextContent('That item is locked.');
    });
  });
});
