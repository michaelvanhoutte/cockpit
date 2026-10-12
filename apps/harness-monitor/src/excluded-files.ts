import excluded from './excluded-files.json';

/**
 * Whether `path` is a lockfile, snapshot or generated file, left out of a pull
 * request's size. Patterns follow .gitignore: one without a slash matches a
 * file or directory of that name at any depth, a trailing slash matches
 * directories only, and one with a slash inside is anchored at the repository's
 * root. `*` stops at a slash, `**` does not, `?` is one character.
 */
export function isExcluded(path: string, patterns: readonly string[] = excluded.patterns): boolean {
  return patterns.some((pattern) => toRegExp(pattern).test(path));
}

const compiled = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  let regExp = compiled.get(pattern);
  if (!regExp) {
    const directory = pattern.endsWith('/');
    const body = directory ? pattern.slice(0, -1) : pattern;
    let glob = '';
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i]!;
      if (c === '*' && body[i + 1] === '*') {
        i += 1;
        glob += '.*';
      } else if (c === '*') glob += '[^/]*';
      else if (c === '?') glob += '[^/]';
      else glob += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
    const anchored = body.includes('/') ? '^' : '(?:^|/)';
    // A directory pattern needs something after it; any other may be the file itself or a directory holding it.
    regExp = new RegExp(`${anchored}${glob}${directory ? '/' : '(?:/|$)'}`);
    compiled.set(pattern, regExp);
  }
  return regExp;
}
