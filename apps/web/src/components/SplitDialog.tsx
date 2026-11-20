import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState } from 'react';
import {
  SPLIT_ITEMS_AT_ONCE,
  TITLE_LENGTH,
  cutTo,
  additionsOf,
  itemLabel,
  splitBlocksOf,
  uuidv7,
  workspaceIsDecided,
  wordsOfBlocks,
  type Item,
  type SplitBlock,
  type SplitCard,
} from '@cockpit/shared';
import { attachmentUrl } from '../api/client';
import { momentDayMonthLabel } from '../dateFormat';
import { useSendCommand } from '../api/queries';
import { proposeASplit } from '../api/split';
import { useSnapshot } from '../api/useSnapshot';
import { useUndo } from '../undo';

/** The theme's category colours a proposed Item and its blocks share, each a solid and its tint, which both themes define. */
const TAGS = ['violet', 'teal', 'amber', 'green', 'slate', 'grey'].map((name) => ({
  solid: `var(--color-cat-${name})`,
  tint: `var(--color-cat-${name}-tint)`,
}));

/** One card as the dialog holds it: what its Item would be called, whether it is made, and a key of its own. */
interface Card {
  key: string;
  title: string;
  on: boolean;
}

/** What a card with nothing to go by is called, from the words of the first block in it. */
const firstWords = (text: string) => {
  const words = cutTo(text.replace(/[#*_>`]/g, '').trim().split(/\s+/).slice(0, 6).join(' '), TITLE_LENGTH);
  return words.length > 0 ? words.replace(/[.,;:]$/, '') : 'New Item';
};

/**
 * *Split* ("Brainstorming: a note holding several ideas can't be taken apart",
 * issue 1828): the POC's dialog, *A · Split: blocks dragged into proposed
 * Items*, wired to stored data. The Item's paragraphs, Additions and files are
 * drawn at once as blocks in their own order; Claude's proposed Items fill in as
 * cards when its answer arrives (`proposeASplit`), each block tagged with its
 * card's name. A block is moved by dragging it onto another card, or by the
 * tag on it, which is also how a keyboard or a phone moves one. Where Claude
 * cannot be asked, or proposes nothing, one card holds every block.
 *
 * Pressing Split sends one change (`split_item`) naming the blocks of each card,
 * never their words, and offers Undo (`unsplit_item`).
 */
export default function SplitDialog({
  workspaceId,
  itemId,
  onClose,
  onSplit,
  returnFocusTo,
}: {
  workspaceId: string;
  itemId: string;
  onClose: () => void;
  /** Called once the change is on its way: the Item's form, which holds the words from before it, closes. */
  onSplit?: (() => void) | undefined;
  /** Where the focus goes back to once it closes: the row's menu button, when it was opened from one. */
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const { data } = useSnapshot(workspaceId);
  const item = data?.items.find((one) => one.id === itemId);
  // Drawn once, from what the Item held when the window opened: the store checks the words are still those.
  const [read, setRead] = useState<{ item: Item; blocks: SplitBlock[] } | null>(null);
  useEffect(() => {
    if (read || !item || !data) return;
    setRead({
      item,
      blocks: splitBlocksOf(
        item,
        additionsOf(data.additions, item.id),
        (data.attachments ?? []).filter((attachment) => attachment.itemId === item.id),
      ),
    });
  }, [read, item, data]);

  const [cards, setCards] = useState<Card[] | null>(null);
  const [placed, setPlaced] = useState<Record<string, string | null>>({});
  /** Whether the cards are Claude's: false where it could not be asked, and the one card is ours. */
  const [claudeProposed, setClaudeProposed] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const send = useSendCommand();
  const offerToUndo = useUndo();

  const blocks = useMemo(() => read?.blocks ?? [], [read]);
  const hasBlocks = read !== null;
  useEffect(() => {
    if (!hasBlocks) return;
    const ask = new AbortController();
    let gone = false;
    const arrive = (proposed: SplitCard[] | null) => {
      if (gone) return;
      const cardsOf =
        proposed && proposed.length > 0
          ? proposed
          : [{ title: firstWords(blocks.find((block) => block.kind === 'paragraph')?.text ?? ''), blockIds: blocks.map((block) => block.id) }];
      const made = cardsOf.map((card) => ({ key: uuidv7(), title: card.title, on: true }));
      const where: Record<string, string | null> = {};
      cardsOf.forEach((card, n) => card.blockIds.forEach((id) => (where[id] = made[n]!.key)));
      setClaudeProposed(proposed !== null && proposed.length > 0 ? proposed.length : 0);
      setPlaced(where);
      setCards(made);
    };
    // Nothing to propose from fewer than two blocks; the dialog then draws the one card at once.
    if (blocks.length < 2) arrive(null);
    else proposeASplit(workspaceId, itemId, ask.signal).then((proposal) => arrive(proposal.cards), () => arrive(null));
    return () => {
      gone = true;
      ask.abort();
    };
  }, [hasBlocks, blocks, workspaceId, itemId]);

  if (!item || !read) return null;
  const tagOf = (cardKey: string | null | undefined) => {
    const at = (cards ?? []).findIndex((card) => card.key === cardKey && card.on);
    return at === -1 ? null : { n: at + 1, colour: TAGS[at % TAGS.length]!, name: cards![at]!.title.trim() || `Item ${at + 1}` };
  };
  const making = (cards ?? []).filter((card) => card.on);
  const setCard = (key: string, change: Partial<Card>) => setCards((was) => (was ?? []).map((card) => (card.key === key ? { ...card, ...change } : card)));

  const dropOn = (cardKey: string) => (event: React.DragEvent) => {
    event.preventDefault();
    const blockId = event.dataTransfer.getData('application/x-split-block');
    if (blockId) setPlaced((was) => ({ ...was, [blockId]: cardKey }));
    setOver(null);
  };

  const split = () => {
    if (!cards) return;
    const envelope = () => ({ commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId });
    const children = making.map((card) => ({
      itemId: uuidv7(),
      title: cutTo(card.title.trim(), TITLE_LENGTH) || 'Untitled',
      blockIds: blocks.filter((block) => placed[block.id] === card.key).map((block) => block.id),
    }));
    const moved = new Set(children.flatMap((child) => child.blockIds));
    const keptWords = blocks.filter((block) => block.kind === 'paragraph' && !moved.has(block.id));
    const was = read.item.description ?? '';
    const answer = send({ name: 'split_item', payload: { ...envelope(), itemId, was, children } });
    const label = itemLabel(read.item);
    offerToUndo({
      what: `“${label}” split into ${children.length} ${children.length === 1 ? 'Item' : 'Items'}`,
      unlessRefused: answer,
      // **No way back once it belonged to no Workspace**: a Split settles it in this one, as going inside another Item does.
      ...(workspaceIsDecided(read.item)
        ? {
            undo: () =>
              send({
                name: 'unsplit_item',
                payload: {
                  ...envelope(),
                  itemId,
                  description: read.item.description ?? null,
                  kept: keptWords.length === 0 ? null : wordsOfBlocks(keptWords),
                  children: children.map((child) => ({
                    itemId: child.itemId,
                    additionIds: child.blockIds.filter((id) => id.startsWith('a-')).map((id) => id.slice(2)),
                    attachmentIds: child.blockIds.filter((id) => id.startsWith('f-')).map((id) => id.slice(2)),
                  })),
                },
              }),
          }
        : {}),
    });
    onClose();
    onSplit?.();
  };

  const intro = !cards
    ? 'Claude is reading it to propose new Items…'
    : claudeProposed > 0
      ? `Claude proposes ${claudeProposed} new ${claudeProposed === 1 ? 'Item' : 'Items'}. Each colour is one Item. Drag a block onto another Item to move it, or untick an Item to keep its blocks here.`
      : 'Claude could not propose a split, so everything is in one Item. Drag blocks onto another Item, add more Items, or untick one to keep its blocks here.';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-1/2 flex max-h-[90vh] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">Split “{itemLabel(read.item)}”</Dialog.Title>
          <p className="-mt-2 text-sm text-ink-soft" role="status">
            {intro}
          </p>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto md:grid-cols-2">
            <section className="well flex flex-col gap-2 p-3" aria-label="What it holds">
              <h3 className="text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">What it holds</h3>
              {blocks.length === 0 && <p className="text-sm text-ink-faint">Nothing written in it to split.</p>}
              {blocks.map((block) => {
                const tag = tagOf(placed[block.id]);
                return (
                  <div
                    key={block.id}
                    draggable={cards !== null}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-split-block', block.id);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    data-block={block.id}
                    className="flex items-start gap-2 rounded-md border border-shade/10 bg-field p-2 text-sm"
                    style={tag ? { boxShadow: `inset 3px 0 0 0 ${tag.colour.solid}` } : undefined}
                  >
                    <span aria-hidden="true" className="cursor-grab select-none pt-0.5 text-ink-faint" title="Drag to an Item">
                      ⠿
                    </span>
                    {block.kind === 'attachment' ? (
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {block.contentType.startsWith('image/') ? (
                          <img src={attachmentUrl(block.id.slice('f-'.length))} alt="" draggable={false} className="size-10 rounded object-cover" />
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
                          <span className="mr-1 text-xs font-medium text-ink-faint">
                            Added {momentDayMonthLabel(block.createdAt, new Date())} ·
                          </span>
                        )}
                        <span className="line-clamp-4 whitespace-pre-wrap">{block.text}</span>
                      </span>
                    )}
                    {cards && (
                      // The tag is the way to move a block without dragging it: a keyboard, and a phone, which cannot drag.
                      <select
                        aria-label={`Where “${block.text.slice(0, 40)}” goes`}
                        value={tag ? (placed[block.id] ?? '') : ''}
                        onChange={(event) => setPlaced((was) => ({ ...was, [block.id]: event.target.value || null }))}
                        className={`max-w-36 shrink-0 truncate rounded-full border-0 px-2 py-0.5 text-xs font-semibold ${tag ? '' : 'bg-cat-grey-tint text-cat-grey'}`}
                        style={tag ? { background: tag.colour.tint, color: tag.colour.solid } : undefined}
                      >
                        <option value="">Stays here</option>
                        {cards.map((card, n) => (
                          <option key={card.key} value={card.key} disabled={!card.on}>
                            {card.title.trim() || `Item ${n + 1}`}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </section>
            <section className="flex flex-col gap-2" aria-label="New Items">
              <h3 className="text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">
                {claudeProposed > 0 ? 'New Items Claude proposes' : 'New Items'}
              </h3>
              {!cards && (
                <div aria-hidden="true" className="flex flex-col gap-2">
                  {[0, 1].map((n) => (
                    <div key={n} className="h-20 animate-pulse rounded-md border border-shade/10 bg-field" />
                  ))}
                </div>
              )}
              {(cards ?? []).map((card, n) => {
                const colour = TAGS[n % TAGS.length]!;
                const inIt = blocks.filter((block) => placed[block.id] === card.key);
                return (
                  <div
                    key={card.key}
                    data-proposal={n + 1}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOver(card.key);
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={dropOn(card.key)}
                    className={`flex flex-col gap-2 rounded-md border bg-field p-3 ${
                      over === card.key ? 'border-accent ring-2 ring-accent-soft/40' : 'border-shade/10'
                    } ${card.on ? '' : 'opacity-50'}`}
                    style={{ borderLeft: `4px solid ${colour.solid}` }}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={card.on}
                        aria-label={`Make Item ${n + 1}`}
                        onChange={(event) => setCard(card.key, { on: event.target.checked })}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="rounded-full px-1.5 text-xs font-semibold" style={{ background: colour.tint, color: colour.solid }}>
                        {n + 1}
                      </span>
                      <input
                        value={card.title}
                        maxLength={200}
                        aria-label={`Title of Item ${n + 1}`}
                        onChange={(event) => setCard(card.key, { title: event.target.value })}
                        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-ink-strong outline-none hover:border-shade/10 focus:border-accent"
                      />
                    </div>
                    {inIt.map((block) => (
                      <p key={block.id} className="line-clamp-2 pl-6 text-xs text-ink-soft">
                        {block.text}
                      </p>
                    ))}
                    <p className="rounded border border-dashed border-shade/20 py-2 text-center text-xs text-ink-faint">Drop a block here</p>
                  </div>
                );
              })}
              {cards && cards.length < SPLIT_ITEMS_AT_ONCE && (
                <button
                  type="button"
                  onClick={() => setCards((was) => [...(was ?? []), { key: uuidv7(), title: '', on: true }])}
                  className="self-start rounded-md px-2 py-1 text-sm text-accent-deep hover:bg-accent-tint"
                >
                  + Another Item
                </button>
              )}
            </section>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-shade/10 pt-3">
            <p className="text-sm text-ink-soft">
              {cards ? `Makes ${making.length} ${making.length === 1 ? 'Item' : 'Items'}. ` : ''}
              {itemLabel(read.item)} becomes their parent and keeps what isn't split off.
            </p>
            <div className="flex shrink-0 gap-2">
              <Dialog.Close className="rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
                Cancel
              </Dialog.Close>
              <button
                type="button"
                onClick={split}
                disabled={!cards || making.length === 0}
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
