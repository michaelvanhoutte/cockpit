import { repeatsTitle, type RepeatRule } from '@cockpit/shared';

/** A repeating row's mark, among its title marks; its hover reads *Repeats weekly on Monday*. */
export function RepeatsMark({ repeat }: { repeat: RepeatRule | null | undefined }) {
  if (!repeat) return null;
  const label = repeatsTitle(repeat);
  return (
    <span className="shrink-0 text-ink-faint" title={label} aria-label={label} role="img">
      ↻
    </span>
  );
}
