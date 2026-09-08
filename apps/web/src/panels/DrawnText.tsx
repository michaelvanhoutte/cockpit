import Markdown from 'react-markdown';
import '../description/description.css';

/**
 * A panel's words, drawn as what they mean rather than as the characters that
 * were typed ("Format what a panel says, without making every dashboard pay for
 * an editor", issue 251).
 *
 * **Its own lazy chunk, and that is the whole point of the split.** Editing
 * Markdown costs the ProseMirror stack the item form's description carries;
 * drawing it costs a parser and a renderer. A dashboard of panels nobody is
 * writing in therefore never fetches the editor at all - which is the cost
 * `docs/ideas.md` raised against text panels in the first place, and what the
 * two defaults exist to avoid (architecture, "Performance budgets").
 *
 * **`react-markdown`, which is what the spike chose for exactly this**
 * (docs/rich-text-options.md, "The Markdown renderer for the read-only view").
 *
 * Two of its defaults are load-bearing and are deliberately left alone: it does
 * not render raw HTML unless asked to, so markup in what somebody typed reads
 * as the text it is; and `defaultUrlTransform` empties a link whose protocol is
 * not a safe one, so `[x](javascript:...)` in a panel is inert. That is the
 * same rule `description/safeHref.ts` enforces on the way *in*, and it is what
 * makes this renderer safe to point at text anybody with the panel can write.
 *
 * It wears `description-prose`, the styles the editor draws its own document
 * with, so asking for formatting changes what the words say and not how they
 * are set.
 */
export default function DrawnText({ body }: { body: string }) {
  return (
    <div className="description-prose min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <Markdown>{body}</Markdown>
    </div>
  );
}
