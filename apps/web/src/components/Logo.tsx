import { litForChrome } from '../chrome';

/**
 * The mark: a bold "C" with a dot in its mouth, the dot in the workspace's
 * tint. Drawn on the top bar, so the tint is lifted the way every tint on the
 * chrome is (chrome.ts). `public/icon.svg` is the same mark on a graphite tile
 * with the default violet dot.
 */
export function Logo({ tint }: { tint: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" className="size-6 shrink-0">
      <path
        d="M43.8 20.4A18 18 0 1 0 43.8 43.6"
        fill="none"
        stroke="#f2f1f8"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle data-logo-dot cx="47" cy="32" r="5.5" fill={litForChrome(tint)} />
    </svg>
  );
}
