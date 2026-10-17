/**
 * Whether a text points anybody anywhere: the checks every text a model wrote
 * from a stranger's words is held to before it is shown or kept ("Propose what
 * to do with each item before you look", issue 1161; "Remember an edit as a
 * sentence you confirm", issue 1163). Pure, and here rather than with either
 * reader because the proposal reader, the offer reader and the command that
 * keeps a sentence all apply the same rules.
 */

/**
 * Compatibility forms folded, so a fullwidth `＠` or `．` reads as the `@` or
 * `.` it shows, and the invisible format characters taken out, so a command
 * or a domain split by a zero-width character reads as the one it shows.
 */
export function folded(text: string): string {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

/**
 * Any format or control character left once whitespace is read as one space:
 * a zero-width joiner or space, a bidi override, a byte-order mark. None has a
 * place in one line of words, and each is how a domain or a command is made to
 * read as something else. Checked on the text as written, before it is folded.
 */
export function hasHiddenCharacters(text: string): boolean {
  return /[\p{Cf}\p{Cc}]/u.test(text.replace(/\s+/g, ' '));
}

/**
 * An `@`, a scheme, a `www.`, a domain with a path or a common ending, one
 * written out to dodge those (`evil[.]com`, `evil dot com`, `hxxp`), a wallet
 * address, a key or token, or a phone number - what a reason would need to
 * point anybody anywhere - and any hidden character.
 */
export function pointsSomewhere(text: string): boolean {
  if (hasHiddenCharacters(text)) return true;
  const said = folded(text);
  if (ADDRESS_OR_LINK.test(said) || BARE_DOMAIN.test(said) || WRITTEN_OUT_DOMAIN.test(said)) return true;
  if (WALLET_OR_KEY.test(said)) return true;
  return (said.match(PHONE_LIKE) ?? []).some((run) => run.replace(/\D/g, '').length >= 9);
}

const ADDRESS_OR_LINK = /@|[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bhxxps?\b/i;

const TOP_LEVEL = 'com|net|org|info|biz|io|ly|co|me|app|dev|xyz|be|nl|uk|de|fr|eu|ru|cn|top|site|online|link|click';

/** `bit.ly/x`, `evilpay.com`: a name with a dot and a path, or one ending the way a site's name commonly does. */
const BARE_DOMAIN = new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:[a-z]{2,}\\/|(?:${TOP_LEVEL})\\b)`, 'i');

/** A domain spelled so the dot is not one: `evil[.]com`, `evil (dot) com`, `evil dot com`. */
const WRITTEN_OUT_DOMAIN = new RegExp(
  `[a-z0-9-](?:\\s*[\\[(]\\s*(?:\\.|dot)\\s*[\\])]\\s*|\\s+dot\\s+)(?:${TOP_LEVEL})\\b`,
  'i',
);

/**
 * A Bitcoin or Ethereum address, a key of the shapes services issue
 * (`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`), or any run of 32 or more letters,
 * digits and `-_` - a token, not a word.
 */
const WALLET_OR_KEY =
  /\b(?:bc1|tb1)[a-z0-9]{20,}\b|\b0x[a-f0-9]{30,}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_][A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{12,}\b|[A-Za-z0-9_-]{32,}/;

/** A run of digits and the separators a phone number is written with; one of nine digits or more is a number to call. */
const PHONE_LIKE = /\+?\d[\d\s().\/-]{6,}\d/g;

/**
 * A scheme, a `www.`, or the opening of a download-and-run, an install, a
 * clone, a run as another user, an encoded or evaluated command, or a change
 * of a file's permissions.
 */
export const LINK_OR_COMMAND = new RegExp(
  [
    '[a-z][a-z0-9+.-]*:\\/\\/',
    '\\bwww\\.',
    '\\bhxxps?\\b',
    '\\b(?:curl|wget)\\s',
    '\\|\\s*(?:ba|z|k)?sh\\b',
    '\\b(?:ba|z|k)?sh\\s+-c\\b',
    '\\bnpx\\b',
    '\\b(?:npm|pnpm|yarn|bun)\\s+(?:i|add|install|exec|dlx|x|create)\\b',
    '\\bpip3?\\s+install\\b',
    '\\b(?:brew|apt|apt-get|cargo|go|gem|choco|winget|scoop|dnf|yum|pacman|dotnet\\s+tool)\\s+install\\b',
    '\\bgit\\s+clone\\b',
    '\\bsudo\\b',
    '\\b(?:powershell|pwsh)\\b',
    '\\s-enc(?:odedcommand)?\\b',
    '\\bbase64\\b',
    '\\bchmod\\b',
    '\\beval\\b',
    '\\biex\\b',
    '\\binvoke-expression\\b',
  ].join('|'),
  'i',
);
