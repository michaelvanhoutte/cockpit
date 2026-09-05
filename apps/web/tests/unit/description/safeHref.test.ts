import { describe, expect, it } from 'vitest';
import { safeHref } from '../../../src/description/safeHref';

/**
 * F1: the addresses a description's link is allowed to carry.
 *
 * Cockpit's own check rather than the editor's. Milkdown renders an unsafe
 * scheme as an empty `href` and so does every other candidate surveyed, but all
 * of them keep it in the *stored* Markdown - which is the text a connector, an
 * export, or a future editor reads (docs/rich-text-options.md, "Two
 * corrections to what is written above").
 */
describe('Item editing', () => {
  describe('a link in a description can only go somewhere a link may go', () => {
    it.each([
      { situation: 'a web address', typed: 'https://example.com/a?b=1', kept: 'https://example.com/a?b=1' },
      { situation: 'a web address without the s', typed: 'http://example.com', kept: 'http://example.com' },
      { situation: 'an email address', typed: 'mailto:ana@example.com', kept: 'mailto:ana@example.com' },
      // What actually gets pasted out of an address bar or a chat message.
      { situation: 'a bare host, as pasted', typed: 'example.com/runbook', kept: 'https://example.com/runbook' },
      { situation: 'surrounding whitespace', typed: '  https://example.com  ', kept: 'https://example.com' },
      { situation: 'an address that only looks odd', typed: 'https://example.com/javascript:alert(1)', kept: 'https://example.com/javascript:alert(1)' },
      // A colon is not a scheme. Read as one, the host in front of a port is an
      // unknown scheme and the whole address is refused.
      { situation: 'a bare host with a port', typed: 'example.com:8080/runbook', kept: 'https://example.com:8080/runbook' },
      { situation: 'a machine on the network with a port', typed: 'localhost:3000', kept: 'https://localhost:3000' },
      { situation: 'a web address with a port', typed: 'https://example.com:8443/a', kept: 'https://example.com:8443/a' },
    ])('$situation is kept', ({ typed, kept }) => {
      expect(safeHref(typed)).toBe(kept);
    });

    it.each([
      { situation: 'a javascript address', typed: 'javascript:alert(1)' },
      { situation: 'a data address', typed: 'data:text/html,<script>alert(1)</script>' },
      { situation: 'a vbscript address', typed: 'vbscript:msgbox(1)' },
      { situation: 'a file address', typed: 'file:///etc/passwd' },
      // Cased and spaced to get past a naive prefix check, both of which a
      // browser ignores when it reads the scheme.
      { situation: 'a javascript address in capitals', typed: 'JaVaScRiPt:alert(1)' },
      { situation: 'a javascript address with a tab in it', typed: 'java\tscript:alert(1)' },
      { situation: 'a javascript address with a zero-width space in it', typed: 'java​script:alert(1)' },
      { situation: 'a javascript address behind a newline', typed: '\njavascript:alert(1)' },
      { situation: 'nothing at all', typed: '   ' },
    ])('$situation is refused', ({ typed }) => {
      expect(safeHref(typed)).toBeNull();
    });
  });
});
