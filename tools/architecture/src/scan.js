/**
 * Reading source text without a compiler: what a file says outside its
 * comments, which declared source names it, and what it imports. Pure.
 */

/** A `/` here opens a regular expression rather than dividing. */
const BEFORE_A_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '>', '~', '^']);

/**
 * The text with every comment blanked out and everything else kept, strings and
 * template literals included: a name inside `'gmail'` is code, the same name
 * after `//` is not. A quote closes at the end of its line, so a stray
 * apostrophe in JSX text costs one line and never the rest of the file.
 */
export function codeOf(text) {
  const out = [];
  const n = text.length;
  const openedAt = []; // the brace depth at which each open `${` closes
  let depth = 0;
  let inTemplate = false;
  let last = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (inTemplate) {
      if (c === '\\') {
        out.push(text.slice(i, i + 2));
        i += 2;
      } else if (c === '`') {
        out.push(c);
        inTemplate = false;
        last = '`';
        i += 1;
      } else if (c === '$' && next === '{') {
        out.push('${');
        openedAt.push(depth);
        inTemplate = false;
        last = '{';
        i += 2;
      } else {
        out.push(c);
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      out.push(' ');
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
      last = c;
    } else if (c === '`') {
      out.push(c);
      inTemplate = true;
      i += 1;
    } else if (c === '/' && BEFORE_A_REGEX.has(last)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j += 1;
      }
      out.push(text.slice(i, j + 1));
      i = j + 1;
      last = '/';
    } else {
      if (c === '{') depth += 1;
      else if (c === '}') {
        if (openedAt.length > 0 && openedAt[openedAt.length - 1] === depth) {
          openedAt.pop();
          inTemplate = true;
        } else depth -= 1;
      }
      out.push(c);
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
  }
  return out.join('');
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Identifiers read as words: `GmailMark`, `gmail_check` and `GMAIL` all say gmail, `gmailish` does not. */
const asWords = (code) =>
  code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();

/**
 * Whether `code` (see codeOf) names a source: any of its phrases as whole
 * words, in any case, with a space, `-`, `_` or a case change between a
 * phrase's own words (`Claude Code`, `claude-code`, `ClaudeCode`).
 */
export function names(code, source) {
  const words = asWords(code);
  return source.words.some((phrase) => {
    const pattern = phrase.trim().split(/\s+/).map(escapeRegExp).join('[\\s_-]*');
    return new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`).test(words);
  });
}

const IMPORTS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g,
];

/** Every module a file imports, comments aside. */
export function importsOf(text) {
  const code = codeOf(text);
  return [...new Set(IMPORTS.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[2])))];
}
