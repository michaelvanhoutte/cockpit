import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import { LINE_STYLES, SWATCHES, type LineKind, type LineStyle, type Swatch } from '@cockpit/shared/board';
import { DASHES, lineInk } from './links';

/**
 * A Workspace's line kinds on its whiteboards ("Brainstorming: the whiteboard
 * can't show how Items connect", issue 1831), as the POC drew them: a sample
 * of each, the toolbar's picker of the kind the next link is drawn as, and
 * *+ New kind…*. An added kind is renamed, redrawn or deleted from its row in
 * the picker; *Leads to* and *Related* are every Workspace's and offer neither.
 */

/** A short stretch of line drawn as the kind draws a link: its style, colour and arrowhead. */
export function KindSample({ kind, width = 28 }: { kind: Pick<LineKind, 'style' | 'colour' | 'arrow'>; width?: number }) {
  const ink = lineInk(kind);
  return (
    <svg width={width} height={10} aria-hidden="true" className="shrink-0">
      {kind.style === 'double' ? (
        <>
          <line x1={1} y1={3} x2={width - 6} y2={3} stroke={ink} strokeWidth={1.5} />
          <line x1={1} y1={7} x2={width - 6} y2={7} stroke={ink} strokeWidth={1.5} />
        </>
      ) : (
        <line x1={1} y1={5} x2={width - 6} y2={5} stroke={ink} strokeWidth={2} strokeDasharray={DASHES[kind.style]} strokeLinecap="round" />
      )}
      {kind.arrow && <path d={`M${width - 7} 1 L${width - 1} 5 L${width - 7} 9 Z`} fill={ink} />}
    </svg>
  );
}

const capitalised = (word: string) => word[0]!.toUpperCase() + word.slice(1);

export type KindFields = Pick<LineKind, 'name' | 'style' | 'colour' | 'arrow'>;

/** A kind's name, style, colour and arrowhead, as made or changed. Empty names are not offered. */
export function KindForm({ initial, submit, onDone, onCancel }: { initial?: KindFields; submit: string; onDone: (kind: KindFields) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [style, setStyle] = useState<LineStyle>(initial?.style ?? 'dashed');
  const [colour, setColour] = useState<Swatch>(initial?.colour ?? 'violet');
  const [arrow, setArrow] = useState(initial?.arrow ?? true);
  return (
    <form
      className="flex flex-col gap-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onDone({ name: name.trim(), style, colour, arrow });
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder="Name, e.g. Blocks"
        aria-label="Name of the line kind"
        className="rounded-md border border-shade/10 bg-field px-2 py-1 text-sm outline-none focus:border-accent"
      />
      <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Style">
        {LINE_STYLES.map((one) => (
          <button
            key={one}
            type="button"
            role="radio"
            aria-checked={style === one}
            aria-label={capitalised(one)}
            onClick={() => setStyle(one)}
            className={`flex flex-col items-center gap-0.5 rounded border px-1 py-1 text-[10px] ${style === one ? 'border-accent bg-accent-tint' : 'border-shade/10'}`}
          >
            <KindSample kind={{ style: one, colour, arrow: false }} width={30} />
            {one}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
        {SWATCHES.map((one) => (
          <button
            key={one}
            type="button"
            role="radio"
            aria-checked={colour === one}
            aria-label={capitalised(one)}
            title={capitalised(one)}
            onClick={() => setColour(one)}
            className={`size-5 rounded-full ${colour === one ? 'ring-2 ring-accent ring-offset-2' : ''}`}
            style={{ background: lineInk({ colour: one }) }}
          />
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={arrow} onChange={(event) => setArrow(event.target.checked)} className="accent-[var(--color-accent)]" />
        Arrowhead
      </label>
      <div className="flex justify-end gap-1">
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-xs text-ink-soft hover:bg-accent-tint">
          Cancel
        </button>
        <button type="submit" className="milled rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent">
          {submit}
        </button>
      </div>
    </form>
  );
}

/**
 * The toolbar's picker: the kind the next link is drawn as, each kind with its
 * sample, and *+ New kind…* at the foot. An added kind's row has *Edit* and
 * *Delete*. On a narrow board the trigger is the sample alone.
 */
export function KindPicker({
  kinds,
  kind,
  compact,
  onPick,
  onAdd,
  onEdit,
  onDelete,
}: {
  kinds: readonly LineKind[];
  kind: LineKind;
  compact: boolean;
  onPick: (id: string) => void;
  onAdd: (kind: KindFields) => void;
  onEdit: (kind: LineKind, to: KindFields) => void;
  onDelete: (kind: LineKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState<'new' | LineKind | null>(null);
  const close = () => {
    setOpen(false);
    setMaking(null);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(now) => {
        setOpen(now);
        if (!now) setMaking(null);
      }}
    >
      <Popover.Trigger className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink hover:bg-accent-tint" aria-label="Line kind" title={`Line kind: ${kind.name}`}>
        <KindSample kind={kind} />
        {!compact && `${kind.name} ▾`}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={8} className="z-floating w-64 rounded-md border border-shade/10 bg-surface p-1 shadow-lg" aria-label="Line kinds">
          {making === null ? (
            <>
              {kinds.map((one) => (
                <div key={one.id} className="group/kind flex items-center rounded hover:bg-accent-tint">
                  <button
                    type="button"
                    onClick={() => {
                      onPick(one.id);
                      close();
                    }}
                    aria-pressed={one.id === kind.id}
                    className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm ${one.id === kind.id ? 'font-medium text-accent-deep' : 'text-ink'}`}
                  >
                    <KindSample kind={one} />
                    <span className="truncate">{one.name}</span>
                  </button>
                  {one.role === null && (
                    <>
                      <button
                        type="button"
                        aria-label={`Edit ${one.name}`}
                        title="Edit"
                        onClick={() => setMaking(one)}
                        className="rounded px-1.5 py-1 text-xs text-ink-soft opacity-0 group-hover/kind:opacity-100 focus-visible:opacity-100 hover:text-accent-deep"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${one.name}`}
                        title="Delete"
                        onClick={() => {
                          close();
                          onDelete(one);
                        }}
                        className="rounded px-1.5 py-1 text-xs text-ink-soft opacity-0 group-hover/kind:opacity-100 focus-visible:opacity-100 hover:text-over-ink"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              ))}
              <div className="my-1 h-px bg-shade/10" />
              <button type="button" onClick={() => setMaking('new')} className="w-full rounded px-2 py-1.5 text-left text-sm text-accent-deep hover:bg-accent-tint">
                + New kind…
              </button>
            </>
          ) : making === 'new' ? (
            <KindForm
              submit="Add kind"
              onCancel={() => setMaking(null)}
              onDone={(made) => {
                close();
                onAdd(made);
              }}
            />
          ) : (
            <KindForm
              initial={making}
              submit="Save kind"
              onCancel={() => setMaking(null)}
              onDone={(to) => {
                close();
                onEdit(making, to);
              }}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
