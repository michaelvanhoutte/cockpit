import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { additionsOf, itemLabel } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { attachmentUrl } from '../api/client';
import { stopAsking } from './dialogs';
import { useSendCommand } from '../api/queries';
import { addChildren, isUuid } from './relations';
import { newId } from './store';

/** POC (throwaway): the colours a proposed Item and its blocks share. */
const TAGS = ['#6f62b5', '#0e7490', '#9a5b14', '#0b7a55', '#bf5d55', '#475569'];

interface Block {
  id: string;
  kind: 'paragraph' | 'addition' | 'attachment';
  text: string;
  meta?: string;
  attachmentId?: string;
  contentType?: string;
}

interface Proposal {
  id: string;
  title: string;
  on: boolean;
}

const firstWords = (text: string) => {
  const words = text.replace(/[#*_>`]/g, '').trim().split(/\s+/).slice(0, 6).join(' ');
  return words.length > 0 ? words.replace(/[.,;:]$/, '') : 'New Item';
};

export function SplitDialog({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const item = data?.items.find((one) => one.id === itemId);

  const [blocks] = useState<Block[]>(() => {
    if (!item) return [];
    const paragraphs = (item.description ?? item.capturedMessage ?? '')
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text, n): Block => ({ id: `p${n}`, kind: 'paragraph', text }));
    const additions = additionsOf(data?.additions, item.id).map(
      (addition): Block => ({
        id: `a-${addition.id}`,
        kind: 'addition',
        text: addition.message,
        meta: new Date(addition.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      }),
    );
    const files = (data?.attachments ?? [])
      .filter((attachment) => attachment.itemId === item.id)
      .map(
        (attachment): Block => ({
          id: `f-${attachment.id}`,
          kind: 'attachment',
          text: attachment.filename,
          attachmentId: attachment.id,
          contentType: attachment.contentType,
        }),
      );
    return [...paragraphs, ...additions, ...files];
  });

  /** Canned proposal: the paragraphs in two or three runs, in order. */
  const [proposals, setProposals] = useState<Proposal[]>(() => {
    const paragraphs = blocks.filter((block) => block.kind === 'paragraph');
    const groups = Math.max(2, Math.min(3, Math.ceil(paragraphs.length / 2)));
    return Array.from({ length: groups }, (_, n) => {
      const first = paragraphs[Math.ceil((n * paragraphs.length) / groups)];
      return { id: newId(), title: first ? firstWords(first.text) : `Part ${n + 1}`, on: true };
    });
  });
  const [placed, setPlaced] = useState<Record<string, string | null>>(() => {
    const paragraphs = blocks.filter((block) => block.kind === 'paragraph');
    const out: Record<string, string | null> = {};
    paragraphs.forEach((block, n) => {
      out[block.id] = proposals[Math.min(proposals.length - 1, Math.floor((n * proposals.length) / paragraphs.length))]?.id ?? null;
    });
    return out;
  });
  const [over, setOver] = useState<string | null>(null);

  if (!item) return null;
  const tagOf = (proposalId: string | null | undefined) => {
    const at = proposals.findIndex((proposal) => proposal.id === proposalId);
    return at === -1 ? null : { n: at + 1, colour: TAGS[at % TAGS.length]!, name: proposals[at]!.title || `Item ${at + 1}` };
  };
  const making = proposals.filter((proposal) => proposal.on);

  const dropOn = (proposalId: string | null) => (event: React.DragEvent) => {
    event.preventDefault();
    const blockId = event.dataTransfer.getData('application/x-poc-block');
    if (blockId) setPlaced((was) => ({ ...was, [blockId]: proposalId }));
    setOver(null);
  };

  const split = () => {
    const envelope = () => ({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId });
    const panelIds = (data?.filings ?? []).filter((f) => f.itemId === item.id && isUuid(f.panelId)).map((f) => f.panelId);
    const childIds = making.map((proposal) => {
      const itemId = crypto.randomUUID();
      const text = blocks.filter((block) => placed[block.id] === proposal.id).map((block) => block.text).join('\n\n');
      void send({
        name: 'capture_item',
        payload: { ...envelope(), itemId, title: proposal.title.trim() || 'Untitled', message: text || proposal.title || 'Untitled', ...(panelIds.length ? { panelIds } : {}) },
      });
      return itemId;
    });
    addChildren(workspaceId, item.id, childIds);
    stopAsking();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && stopAsking()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed z-floating left-1/2 top-1/2 flex max-h-[90vh] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">Split “{itemLabel(item)}”</Dialog.Title>
          <p className="-mt-2 text-sm text-ink-soft">
            Claude proposes {proposals.length} new Items. Each colour is one Item. Drag a paragraph to another Item to move it, untick an Item to keep its text here.
          </p>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto md:grid-cols-2">
            <section className="well flex flex-col gap-2 p-3">
              <h3 className="text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">What it holds</h3>
              {blocks.length === 0 && <p className="text-sm text-ink-faint">Nothing written in it to split.</p>}
              {blocks.map((block) => {
                const tag = tagOf(placed[block.id]);
                return (
                  <div
                    key={block.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-poc-block', block.id);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    data-block={block.id}
                    className="flex items-start gap-2 rounded-md border border-shade/10 bg-field p-2 text-sm"
                    style={tag ? { boxShadow: `inset 3px 0 0 0 ${tag.colour}` } : undefined}
                  >
                    <span aria-hidden="true" className="cursor-grab select-none pt-0.5 text-ink-faint" title="Drag to an Item">
                      ⠿
                    </span>
                    {block.kind === 'attachment' ? (
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {block.contentType?.startsWith('image/') ? (
                          <img src={attachmentUrl(block.attachmentId!)} alt="" className="size-10 rounded object-cover" />
                        ) : (
                          <span className="flex size-10 items-center justify-center rounded bg-cat-grey-tint text-[10px] font-semibold text-cat-grey uppercase">
                            {block.text.split('.').at(-1)?.slice(0, 4)}
                          </span>
                        )}
                        <span className="truncate text-ink">{block.text}</span>
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 text-ink">
                        {block.kind === 'addition' && (
                          <span className="mr-1 text-xs font-medium text-ink-faint">Added {block.meta} ·</span>
                        )}
                        <span className="line-clamp-4">{block.text}</span>
                      </span>
                    )}
                    {tag && (
                      <span
                        className="max-w-36 shrink-0 truncate rounded-full px-2 text-xs font-semibold text-white"
                        style={{ background: tag.colour }}
                        title={`In “${tag.name}”`}
                      >
                        {tag.name}
                      </span>
                    )}
                  </div>
                );
              })}
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">New Items Claude proposes</h3>
              {proposals.map((proposal, n) => {
                const colour = TAGS[n % TAGS.length]!;
                const inIt = blocks.filter((block) => placed[block.id] === proposal.id);
                return (
                  <div
                    key={proposal.id}
                    data-proposal={n + 1}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOver(proposal.id);
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={dropOn(proposal.id)}
                    className={`flex flex-col gap-2 rounded-md border bg-field p-3 ${
                      over === proposal.id ? 'border-accent ring-2 ring-accent-soft/40' : 'border-shade/10'
                    } ${proposal.on ? '' : 'opacity-50'}`}
                    style={{ borderLeft: `4px solid ${colour}` }}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={proposal.on}
                        aria-label={`Make Item ${n + 1}`}
                        onChange={(event) =>
                          setProposals((was) => was.map((one) => (one.id === proposal.id ? { ...one, on: event.target.checked } : one)))
                        }
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="rounded-full px-1.5 text-xs font-semibold text-white" style={{ background: colour }}>
                        {n + 1}
                      </span>
                      <input
                        value={proposal.title}
                        aria-label={`Title of Item ${n + 1}`}
                        onChange={(event) =>
                          setProposals((was) => was.map((one) => (one.id === proposal.id ? { ...one, title: event.target.value } : one)))
                        }
                        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-ink-strong outline-none hover:border-shade/10 focus:border-accent"
                      />
                    </div>
                    {inIt.map((block) => (
                      <p key={block.id} className="line-clamp-2 pl-6 text-xs text-ink-soft">
                        {block.text}
                      </p>
                    ))}
                    <p className="rounded border border-dashed border-shade/20 py-2 text-center text-xs text-ink-faint">
                      Drop a block here
                    </p>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => setProposals((was) => [...was, { id: newId(), title: '', on: true }])}
                className="self-start rounded-md px-2 py-1 text-sm text-accent-deep hover:bg-accent-tint"
              >
                + Another Item
              </button>
            </section>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-shade/10 pt-3">
            <p className="text-sm text-ink-soft">
              Makes {making.length} Items. {itemLabel(item)} becomes their parent and keeps what isn't split off.
            </p>
            <div className="flex shrink-0 gap-2">
              <Dialog.Close className="rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
                Cancel
              </Dialog.Close>
              <button
                type="button"
                onClick={split}
                disabled={making.length === 0}
                className="milled rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Split
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
