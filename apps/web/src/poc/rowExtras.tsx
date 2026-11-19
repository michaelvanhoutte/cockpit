import type * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { createContext, type ReactNode } from 'react';
import { COLOURS, ink, tint, useColourOf, useSetColour } from './colour';

type M = Pick<typeof DropdownMenu, 'Item' | 'Separator' | 'Sub' | 'SubTrigger' | 'SubContent' | 'Portal'>;

/** POC (throwaway): entries the whiteboard adds after a row's own menu, when it draws that menu for a card. */
export const PocRowExtras = createContext<((menu: M) => ReactNode) | null>(null);

/** The row's colour, as a small dot at its start - never a fill, which due dates use. */
export function PocColourDot({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const colour = useColourOf(workspaceId, `item:${itemId}`);
  if (!colour) return null;
  return <span aria-label={`Colour ${colour}`} className="size-2.5 shrink-0 rounded-full" style={{ background: ink(colour) }} />;
}

/** Colour ▸ with the eight swatches and None, in any Radix menu. */
export function PocColourSub({ M, workspaceId, target, className }: { M: M; workspaceId: string; target: string; className: string }) {
  const current = useColourOf(workspaceId, target);
  const setColour = useSetColour(workspaceId);
  return (
    <M.Sub>
      <M.SubTrigger className={`${className} data-[state=open]:bg-accent-tint`}>
        <span className="flex items-center gap-2">
          Colour
          {current && <span className="size-2.5 rounded-full" style={{ background: ink(current) }} />}
        </span>
        <span aria-hidden="true" className="text-xs text-ink-faint">
          ▸
        </span>
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent className="z-floating grid w-44 grid-cols-4 gap-1.5 rounded-md border border-shade/10 bg-surface p-2 shadow-lg">
          {COLOURS.map((colour) => (
            <M.Item
              key={colour}
              aria-label={colour}
              title={colour[0]!.toUpperCase() + colour.slice(1)}
              onSelect={() => setColour(target, colour)}
              className={`size-7 cursor-pointer rounded-full border-2 outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-accent ${current === colour ? 'ring-2 ring-accent ring-offset-1' : ''}`}
              style={{ background: tint(colour), borderColor: ink(colour) }}
            />
          ))}
          <M.Item
            onSelect={() => setColour(target, null)}
            className="col-span-4 cursor-pointer rounded px-2 py-1 text-center text-xs text-ink-soft outline-none data-[highlighted]:bg-accent-tint"
          >
            None
          </M.Item>
        </M.SubContent>
      </M.Portal>
    </M.Sub>
  );
}
