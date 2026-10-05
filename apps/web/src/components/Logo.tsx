import { litForChrome } from '../chrome';

/**
 * The mark: four rounded squares in a two-by-two grid, the fourth in the
 * workspace's tint. Drawn on the top bar, so the tint is lifted the way every
 * tint on the chrome is (chrome.ts). `public/icon.svg` is the same mark on a
 * graphite tile with the default violet square. A C with a square is
 * Conselit's own mark and is never drawn here.
 */
export function Logo({ tint }: { tint: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className="size-6 shrink-0">
      <rect x="3" y="3" width="12" height="12" rx="2.5" className="fill-chrome-ink" />
      <rect x="17" y="3" width="12" height="12" rx="2.5" className="fill-chrome-ink" />
      <rect x="3" y="17" width="12" height="12" rx="2.5" className="fill-chrome-ink" />
      <rect data-logo-dot x="17" y="17" width="12" height="12" rx="2.5" fill={litForChrome(tint)} />
    </svg>
  );
}
