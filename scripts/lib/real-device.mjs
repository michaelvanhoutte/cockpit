//
// The real-device gate ("Fail the Checks job when an outside service has no
// live contract case, and hold a pull request whose real-device check was not
// done", issue 1426): /build does not mark a pull request ready while a
// real-device line in its body has no result.
//
// The marked line form, one per check, in the walk:
//
//   Real device: <the device> - <what happened>
//
// The separator is a spaced hyphen, en dash or em dash. Prose that merely
// mentions a phone is not the form and is never read. Pure: a body in,
// a verdict out; scripts/real-device-gate.mjs reads the body with gh.
//

// After any quote, bullet or number, and with any bold or italic around the
// label, since a line the gate cannot see would pass with no result.
const LINE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?[*_]*real device[*_]*\s*:[*_]*\s*(.*)$/i;
const SEPARATOR = /\s[-–—]\s/;
// A result left as the template's placeholder, or as a promise, is no result.
const NO_RESULT = /^(?:<[^>]*>|\[[^\]]*\]|\.{3}|…|\?+|todo|tbd|pending|n\/a)\.?$/i;

/** The result of one real-device line: what follows the device, '' where nothing does. @param {string} rest */
function resultOf(rest) {
  const split = SEPARATOR.exec(rest);
  if (!split) return '';
  return rest.slice(split.index + split[0].length).trim();
}

/**
 * Each real-device line in the body, with whether it carries a result.
 * @param {string} body
 * @returns {{ line: string, done: boolean }[]}
 */
export function realDeviceLines(body) {
  const found = [];
  for (const line of body.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const result = resultOf(match[1].trim());
    found.push({ line: line.trim(), done: result !== '' && !NO_RESULT.test(result) });
  }
  return found;
}

/**
 * Whether the pull request may be marked ready, and the refusals if not. A
 * body that could not be read (`null`) is refused: failing closed is the point.
 * @param {string | null} body
 * @returns {{ ok: boolean, refusals: string[] }}
 */
export function realDeviceGate(body) {
  if (body === null) return { ok: false, refusals: ["could not read the pull request body, so its real-device lines could not be checked"] };
  const refusals = realDeviceLines(body)
    .filter(({ done }) => !done)
    .map(({ line }) => `no result on the real-device line: ${line}\n    Do the check on the device and write what happened after the device: Real device: <device> - <what happened>`);
  return { ok: refusals.length === 0, refusals };
}
