import { coloursKey, usePoc } from './store';

/**
 * POC (throwaway): a colour for an Item or a Panel, kept in the browser. Six
 * from the app's categorical palette; rose and sky are the POC's own, given a
 * light and a dark value the same way (`PocColourTokens`).
 */
export const COLOURS = ['slate', 'teal', 'green', 'amber', 'rose', 'violet', 'sky', 'grey'] as const;
export type Colour = (typeof COLOURS)[number];

export const ink = (colour: Colour) => `var(--color-cat-${colour})`;
export const tint = (colour: Colour) => `var(--color-cat-${colour}-tint)`;

/** `item:<id>` or `panel:<id>` → colour. */
export type Colours = Record<string, Colour>;

export function useColours(workspaceId: string) {
  return usePoc<Colours>(coloursKey(workspaceId), {});
}

export function useColourOf(workspaceId: string, key: string): Colour | undefined {
  const [colours] = useColours(workspaceId);
  return colours[key];
}

export function useSetColour(workspaceId: string) {
  const [, setColours] = useColours(workspaceId);
  return (key: string, colour: Colour | null) =>
    setColours((was) => {
      const next = { ...was };
      if (colour) next[key] = colour;
      else delete next[key];
      return next;
    });
}

/** The two colours the app's palette lacks, light and dark. */
export function PocColourTokens() {
  return (
    <style>{`
      :root { --color-cat-rose: #a83f5c; --color-cat-rose-tint: #fbe8ee; --color-cat-sky: #1f6fb2; --color-cat-sky-tint: #e3effa; }
      html[data-app-dark] { --color-cat-rose: #f08aa6; --color-cat-rose-tint: #3a222b; --color-cat-sky: #7cb8ee; --color-cat-sky-tint: #1d2b3a; }
    `}</style>
  );
}

/** The nine choices, as round swatches, for a menu or a popover. */
export function Swatches({ current, onPick }: { current: Colour | undefined; onPick: (colour: Colour | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 p-1" role="radiogroup" aria-label="Colour">
      {COLOURS.map((colour) => (
        <button
          key={colour}
          type="button"
          role="radio"
          aria-checked={current === colour}
          aria-label={colour}
          title={colour[0]!.toUpperCase() + colour.slice(1)}
          onClick={() => onPick(colour)}
          className={`size-6 rounded-full border-2 ${current === colour ? 'ring-2 ring-accent ring-offset-1' : ''}`}
          style={{ background: tint(colour), borderColor: ink(colour) }}
        />
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={!current}
        onClick={() => onPick(null)}
        className={`rounded-full border border-shade/20 px-2 text-xs text-ink-soft ${!current ? 'ring-2 ring-accent ring-offset-1' : ''}`}
      >
        None
      </button>
    </div>
  );
}
