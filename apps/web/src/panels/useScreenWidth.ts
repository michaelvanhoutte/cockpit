import { useCallback, useState, useSyncExternalStore } from 'react';

/**
 * The two widths a dashboard is drawn from, and they are genuinely two numbers
 * ("Panels on a dashboard, with per-screen-size layouts", issue 33).
 *
 * **The screen's width is what a layout is recorded against.** It is what "the
 * current screen width" means in the issue and what a person would answer if
 * asked - "my laptop is 1440" - so it is the number in the question about which
 * layout to change, and the number the automatic choice compares. It stays the
 * window's own width rather than anything measured inside the page, so it goes
 * on meaning the same thing if the page's own furniture ever moves: the Inbox
 * beside the dashboards ("Show the Inbox beside the dashboards instead of as a
 * tab", issue 117) is exactly that kind of furniture, and a layout made before
 * it existed still names the screen it was made on.
 *
 * **The dashboard's own width is what decides how many panels fit across.**
 * That is a different question with a different answer, because the Inbox takes
 * about a fifth of the screen wherever there is room for it: three panels across
 * a 1280px *screen* would be three across nine hundred and ninety pixels, which
 * is not what "at a size worth reading" meant. Measured rather than derived,
 * because deriving it would mean writing the shell's own layout rules down a
 * second time in JavaScript and keeping the two in step by hand.
 */

/** How wide the screen is, in CSS pixels, kept current as the window changes. */
export function useScreenWidth(): number {
  return useSyncExternalStore(subscribe, current, () => FALLBACK_WIDTH);
}

/**
 * How wide the element handed this ref is, kept current as it changes - which
 * is not only when the window does: showing or hiding the Inbox beside it
 * resizes the dashboard without the window moving at all.
 *
 * A callback ref rather than an effect, so the first measurement happens as the
 * element is attached rather than a paint later. Where nothing can be measured
 * - a test runner with no layout engine, a browser without `ResizeObserver` -
 * the answer is `null` and the caller falls back to the screen's width, which
 * is the honest approximation rather than a zero that would make every panel
 * the full width.
 */
export function useMeasuredWidth(): [(element: HTMLElement | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const seen = element.getBoundingClientRect().width;
    setWidth(seen > 0 ? seen : null);
    if (typeof ResizeObserver !== 'function') return;
    const watching = new ResizeObserver((entries) => {
      const now = entries[0]?.contentRect.width ?? 0;
      setWidth(now > 0 ? now : null);
    });
    watching.observe(element);
    // React 19 calls a callback ref's return value as its cleanup, so the
    // observer is disconnected when the element goes rather than being left
    // watching a node nothing points at.
    return () => watching.disconnect();
  }, []);
  return [measure, width];
}

/**
 * What the width is before a window has said otherwise - a render with no
 * window at all. A laptop rather than a phone or a wall: it is the middle of
 * the range, so the arrangement it produces is never absurd in either
 * direction, and the real width replaces it on the first paint.
 */
const FALLBACK_WIDTH = 1280;

function subscribe(onChange: () => void): () => void {
  globalThis.addEventListener?.('resize', onChange);
  return () => globalThis.removeEventListener?.('resize', onChange);
}

function current(): number {
  const width = globalThis.innerWidth;
  return typeof width === 'number' && width > 0 ? width : FALLBACK_WIDTH;
}
