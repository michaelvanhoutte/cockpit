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
// 3. Only Capture's own walks capture through the UI. Any other walk puts the
//    items it needs there through the commands API as the signed-in person
//    (tests/e2e/support/arrange.ts), because capturing through the capture box
//    is seconds of arrangement before the walk reaches what it proves.
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

/** The feature area whose walks capture through the UI because capturing is what they prove. */
export const THE_CAPTURING_AREA = 'Capture';

/**
 * The walks that have not yet been rewritten to arrange through the API, each
 * held at the number of UI captures it makes today.
 *
 * **The list only shrinks.** A file captures no more than its number, and
 * drops off the list in the pull request that removes its last one: the check
 * fails on an entry that is stale, naming the number to write, so a rewrite
 * cannot leave its file exempt. A walk not named here has none to make.
 */
export const STILL_CAPTURING_BY_HAND = {
  'agents.test.ts': { calls: 2, rewrittenWhen: 'next touched' },
  'copy-item-link.test.ts': { calls: 1, rewrittenWhen: 'next touched' },
  'dashboards.test.ts': { calls: 1, rewrittenWhen: 'next touched' },
  'duplicates.test.ts': { calls: 5, rewrittenWhen: 'next touched' },
  'inbox.test.ts': { calls: 1, rewrittenWhen: 'next touched' },
  'item-editing.test.ts': { calls: 15, rewrittenWhen: '"Rewrite the item-editing and capture walks to arrange through the API" (1285)' },
  'screen-edges.test.ts': { calls: 5, rewrittenWhen: 'next touched' },
  'sign-in.test.ts': { calls: 1, rewrittenWhen: 'next touched' },
  'triage.test.ts': { calls: 7, rewrittenWhen: 'next touched' },
};

/**
 * Every use of the `capture(...)` helper in one file's source that sits outside
 * the walks of the `Capture` area, as `{ line, text }`.
 *
 * **The helper is the one door**: it fills the capture box and waits for the
 * Inbox, so a walk calling it spends its seconds there and not on what it
 * proves. The walks about capturing fill the capture box themselves, since
 * that is the behaviour they drive, and a read of source text cannot tell that
 * from arranging - so it is the helper that is named.
 *
 * An area is a `describe('Capture', ...)` block, found by indentation: the
 * block ends at the `});` that closes it at the column it opened on, which is
 * where the formatter puts it. The helper's own definition and a comment are
 * not uses.
 */
export function capturedThroughTheUi(source) {
  const found = [];
  let closesWith = null;
  source.split('\n').forEach((raw, index) => {
    const text = raw.replace(/\r$/, '');
    if (closesWith === null) {
      const opens = text.match(new RegExp(`^(\\s*)(?:test\\.)?describe\\(\\s*['"]${THE_CAPTURING_AREA}['"]`));
      if (opens) closesWith = `${opens[1]}});`;
    } else if (text === closesWith) {
      closesWith = null;
      return;
    }
    if (closesWith !== null) return;
    if (/\bfunction\s+capture\(/.test(text) || /^\s*(?:\/\/|\/?\*)/.test(text)) return;
    if (/(?<![\w.])capture\(/.test(text)) found.push({ line: index + 1, text: text.trim() });
  });
  if (closesWith !== null) {
    throw new Error(
      `a describe('${THE_CAPTURING_AREA}') never closed with ${JSON.stringify(closesWith)} at its own indent, ` +
        'so everything after it would pass unchecked: put its closing line where the formatter does',
    );
  }
  return found;
}
