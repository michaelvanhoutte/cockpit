//
// The conventions of the browser tier that cannot be seen by running it. Each
// is a rule that lived in a comment and is now something that fails.
//
// 1. A workspace tab is pressed through `switchTo` (tests/e2e/support/app.ts).
//    A walk that presses the tab and carries straight on acts on the workspace
//    it just left, because the old one stays on screen while the router reads
//    the new one. It passes on a fast machine every time, so the suite cannot
//    catch it.
// 2. Only the sign-in walks drive the issuer. The run signs in once per person
//    per project and every other walk takes that through `signIn`; a walk that
//    signs in again by hand pays the seconds the shared sign-in exists to save.
//
// Here rather than in the suite: it is a read of source text, so it needs no
// browser, no stack and no install, and the checkout-only Scripts step already
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

/** The one spec whose subject is signing in, so the one allowed to drive the issuer. */
export const THE_SIGN_IN_SPEC = 'sign-in.test.ts';

/**
 * Every line of one file's source that reaches for the issuer's `Continue with
 * Google` link, as `{ line, text }`.
 *
 * **Every line naming the link, not only one that presses it on the spot**: a
 * locator held in a variable and pressed later, or a press wrapped over several
 * lines, still names the link on the line the walk takes hold of it, so this is
 * the one line both shapes share. The exceptions are a line that asserts on the
 * link, since the logon page is looked at by walks that never sign in, and a
 * comment, which presses nothing.
 */
export function issuerDrivenByHand(source) {
  const found = [];
  source.split('\n').forEach((text, index) => {
    if (!text.includes('Continue with Google') || /\bexpect\(/.test(text) || /^\s*(?:\/\/|\/?\*)/.test(text)) return;
    found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}
