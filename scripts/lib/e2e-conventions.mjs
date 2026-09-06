//
// The one convention of the browser tier that cannot be seen by running it.
//
// A walk that presses a workspace tab and carries straight on acts on the
// workspace it just left, because the old one stays on screen while the router
// reads the new one (`switchTo`, tests/e2e/support/app.ts). It passes on a fast
// machine every time, so the suite cannot catch it - and it has already been
// found and fixed twice, once per walk, because the rule lived only in a
// comment. This is the rule as something that fails.
//
// Here rather than in the suite: it is a read of source text, so it needs no
// browser, no stack and no install, and the checkout-only Scripts job already
// runs `node --test scripts/lib/*.test.mjs`.
//

/** The helper that presses a workspace tab and waits for the switch to land. */
export const THE_WAY = 'switchTo';

/**
 * Every press of a workspace tab in one file's source that does not go through
 * `switchTo`, as `{ line, text }`.
 *
 * Text rather than a path, so the shapes below can be asserted without a file.
 *
 * **Both shapes, because both have shipped**: the tab pressed where it is
 * found, and the tab held in a variable first - which is what the walk that
 * failed in CI did, and what a check written against the obvious shape alone
 * would have missed.
 */
export function tabsPressedWithoutWaiting(source) {
  const lines = source.split('\n');
  const held = new Set(
    lines.flatMap((line) => [...line.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*workspaceTab\(/g)].map((m) => m[1])),
  );
  const found = [];
  lines.forEach((text, index) => {
    const pressed = text.match(/\bpress\(\s*(\w+)/);
    if (!pressed) return;
    const target = pressed[1];
    if (target === 'workspaceTab' || held.has(target)) found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}
