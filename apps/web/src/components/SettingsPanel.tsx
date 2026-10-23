/**
 * The frame every area of a Settings section is drawn in: a shaded header
 * naming the area, its contents under it ("Draw every Settings section in
 * headed panels, in the new order", issue 1462).
 *
 * **Only a frame**: what is inside keeps its own behaviour, so a section is
 * redrawn by wrapping what it already drew.
 */
export function SettingsPanel({
  name,
  hint,
  header,
  flush = false,
  className = 'mt-4',
  children,
}: {
  /** The area's name: the title of the header, and what a screen reader calls the panel. */
  name: string;
  /** One line under the name saying what the area is for. */
  hint?: React.ReactNode;
  /** A header of its own, in place of the name and hint - the Workspace panel's, which holds the picker. */
  header?: React.ReactNode;
  /** Rows that run edge to edge, each carrying its own padding and dividing line. */
  flush?: boolean;
  /** The space above it; the first panel of a section sits closer to the intro than the ones after it. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={name}
      className={`${className} shrink-0 overflow-hidden rounded-xl border border-shade/15 bg-surface shadow-sm`}
    >
      <div className="border-b border-shade/10 bg-shade/5 px-4 py-2">
        {header ?? (
          <>
            <p className="text-sm font-semibold text-ink-strong">{name}</p>
            {hint && <p className="text-xs text-ink-faint">{hint}</p>}
          </>
        )}
      </div>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </div>
  );
}
