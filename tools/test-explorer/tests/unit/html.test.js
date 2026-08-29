import { describe, expect, it } from 'vitest';
import { esc, jsonScript } from '../../src/render/html.js';

describe('esc', () => {
  it('leaves plain text untouched', () => {
    expect(esc('a thought captured in the app')).toBe('a thought captured in the app');
  });

  it('escapes every HTML-significant character, including both quote styles', () => {
    expect(esc(`<b>Cats & "dogs" 'n things'</b>`)).toBe('&lt;b&gt;Cats &amp; &quot;dogs&quot; &#39;n things&#39;&lt;/b&gt;');
  });

  it('closes off a script-breakout attempt rather than passing it through', () => {
    expect(esc('</script><script>alert(1)</script>')).toBe('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('coerces a non-string value before escaping it', () => {
    expect(esc(42)).toBe('42');
  });
});

describe('jsonScript', () => {
  it('serializes a plain value the same way JSON.stringify would', () => {
    expect(jsonScript({ a: 1, b: 'x' })).toBe(JSON.stringify({ a: 1, b: 'x' }));
  });

  it('escapes a literal "<" so a string value can never close the surrounding <script> tag', () => {
    // Only "<" needs escaping to break up "</script>" — a bare ">" is not special to an HTML
    // parser scanning for a closing tag, so jsonScript leaves it as JSON.stringify wrote it.
    const payload = jsonScript({ label: '</script><script>alert(1)</script>' });
    expect(payload).not.toContain('</script>');
    expect(payload).toBe(JSON.stringify({ label: '</script><script>alert(1)</script>' }).replace(/</g, '\\u003c'));
  });

  it('escapes the two Unicode line separators, which JSON.stringify leaves as literal line breaks', () => {
    const payload = jsonScript({ text: 'a\u2028b\u2029c' });
    expect(payload).not.toContain('\u2028');
    expect(payload).not.toContain('\u2029');
    expect(payload).toContain('\\u2028');
    expect(payload).toContain('\\u2029');
  });

  it('reverses cleanly: decoding the escapes back to their real characters reproduces the original value', () => {
    // What a JS parser does with </\u2028/\u2029 inside a string literal \u2014 proves the escaping
    // is round-trippable, not just "contains no raw <script>-breaking characters".
    const value = { label: '</script>', note: 'line one\u2028line two' };
    const decoded = jsonScript(value).replace(/\\u003c/g, '<').replace(/\\u2028/g, '\u2028').replace(/\\u2029/g, '\u2029');
    expect(JSON.parse(decoded)).toEqual(value);
  });
});
