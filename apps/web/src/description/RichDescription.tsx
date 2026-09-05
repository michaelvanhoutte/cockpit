import { useEffect, useRef, useState } from 'react';
import {
  Editor,
  commandsCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/core';
import {
  linkSchema,
  toggleEmphasisCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
} from '@milkdown/preset-commonmark';
import { history } from '@milkdown/plugin-history';
import { $prose, callCommand } from '@milkdown/utils';
import { keymap } from '@milkdown/prose/keymap';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { safeHref } from './safeHref';
import { descriptionSyntax } from './syntax';
import './description.css';

/** Where a request for a link's address is parked while it is being typed. */
interface Asking {
  href: string;
  refused: boolean;
}

/**
 * The five things the toolbar makes, and the key each answers to.
 *
 * Milkdown binds bold and italic to the same two, and binds the lists to
 * `Mod-Alt-7` and `Mod-Alt-8`, which nothing else does; link it does not bind
 * at all. The three that differ are re-bound below to what every other editor
 * uses, so the shortcut a person already knows is the one that works.
 */
const KEY_FOR = {
  bold: 'Mod-b',
  italic: 'Mod-i',
  link: 'Mod-k',
  'bullet list': 'Mod-Shift-8',
  'numbered list': 'Mod-Shift-7',
} as const;

type Formatting = keyof typeof KEY_FOR;

const COMMAND_FOR = {
  bold: toggleStrongCommand,
  italic: toggleEmphasisCommand,
  'bullet list': wrapInBulletListCommand,
  'numbered list': wrapInOrderedListCommand,
} as const;

export interface RichDescriptionProps {
  /** The Markdown to start from. Read once: after that the document is the editor's. */
  initial: string;
  onChange: (markdown: string) => void;
  editable: boolean;
}

/**
 * The formatted view of a description: Milkdown over ProseMirror over remark,
 * chosen on measured chunk size and measured round-trip fidelity
 * (docs/rich-text-options.md, "What the spike found").
 *
 * **This module is the lazy chunk.** It is 135KB compressed against a 200KB
 * budget the entry already spends 173KB of, so nothing on the cold-open path
 * may import it - only `DescriptionBox` may, and only through `React.lazy`.
 *
 * What it may contain is `descriptionSyntax`, which is wider than this toolbar
 * on purpose - see that module.
 */
export default function RichDescription({ initial, onChange, editable }: RichDescriptionProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  // The toolbar is drawn before the editor is built, and every one of its
  // buttons runs a command against that editor. Without this they are live
  // controls that quietly do nothing for as long as the build takes.
  const [ready, setReady] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);

  /**
   * The current handlers, reached from an editor that is built once. Rebuilding
   * it to pick up a new render's closures would throw away the document in it.
   */
  const changed = useRef(onChange);
  changed.current = onChange;
  const askForAnAddress = useRef(() => {});
  askForAnAddress.current = () =>
    setAsking({ href: hrefUnderTheCursor(editor.current) ?? '', refused: false });

  useEffect(() => {
    let live = true;
    const root = host.current;
    if (!root) return;

    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initial);
        ctx.update(editorViewOptionsCtx, (was) => ({
          ...was,
          attributes: {
            'aria-label': 'Description',
            role: 'textbox',
            'aria-multiline': 'true',
            class: 'description-prose',
          },
        }));
      })
      .use(descriptionSyntax)
      .use(history)
      // Every change, as it happens, and not on a timer.
      //
      // `@milkdown/plugin-listener` is the obvious way to do this and is
      // **wrong here**: it debounces by 200ms and cancels what is pending when
      // the editor is destroyed, so pressing bold and then Source - or bold and
      // then Save - inside that window loses the formatting silently. The
      // browser walk found it, twice.
      //
      // The cost is one serialisation per keystroke rather than one per pause.
      // A description is capped at 60,000 characters, where that is a few
      // milliseconds; if it ever reads as lag, the answer is to read the
      // editor when Save and the source view ask rather than to put the timer
      // back.
      .use(
        $prose(
          (ctx) =>
            new Plugin({
              key: new PluginKey('cockpit-description-changed'),
              // Seeded with the document the editor opened on, so what is
              // reported is what somebody did and never the tidying the parse
              // itself performs. Reporting that would mean opening a form,
              // touching nothing, pressing Save, and rewriting the description.
              view: (view) => {
                let last = view.state.doc;
                return {
                  update: (updated) => {
                    if (last.eq(updated.state.doc)) return;
                    last = updated.state.doc;
                    changed.current(ctx.get(serializerCtx)(updated.state.doc));
                  },
                };
              },
            }),
        ),
      )
      .use(
        $prose((ctx) =>
          keymap({
            'Mod-k': () => {
              askForAnAddress.current();
              return true;
            },
            'Mod-Shift-8': () => ctx.get(commandsCtx).call(wrapInBulletListCommand.key),
            'Mod-Shift-7': () => ctx.get(commandsCtx).call(wrapInOrderedListCommand.key),
          }),
        ),
      )
      .create()
      .then((made) => {
        if (!live) {
          void made.destroy();
          return;
        }
        editor.current = made;
        setReady(true);
      });

    return () => {
      live = false;
      void editor.current?.destroy();
      editor.current = null;
    };
    // Built once. `initial` is a starting value and `onChange` is reached
    // through a ref, so neither may rebuild the editor; a new starting value
    // arrives as a new `key` from DescriptionBox instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Closed while a save is in flight, for the reason the other boxes are: what
   * is sent is worked out before the round trip, so anything typed during it
   * would be lost when the form closes.
   *
   * **`ready` is a dependency because the editor is built asynchronously.**
   * Without it this runs once against a `null` editor and never again, so an
   * editor built while a save was already in flight - press Save from the
   * source view, then Formatted - came up writable, which is the case the rule
   * above exists for.
   */
  useEffect(() => {
    editor.current?.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => editable }));
  }, [editable, ready]);

  /**
   * Escape gives up the address being typed, and nothing else.
   *
   * **On `window`, in the capture phase, which is the only place this works.**
   * The form is a Radix dialog, and Radix listens for Escape on the *document*
   * in the capture phase - so it runs before anything inside the dialog sees
   * the key, and neither `preventDefault` nor `stopPropagation` from the input
   * reaches it. The capture phase starts at the window, one step earlier.
   * Without this, Escape out of a link's address closes the form and throws the
   * whole description away; the browser walk went red for exactly that.
   */
  useEffect(() => {
    if (!asking) return;
    const giveUpTheAddress = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setAsking(null);
      focusTheEditor(editor.current);
    };
    window.addEventListener('keydown', giveUpTheAddress, true);
    return () => window.removeEventListener('keydown', giveUpTheAddress, true);
  }, [asking]);

  const apply = (command: Formatting) => {
    if (command === 'link') {
      askForAnAddress.current();
      return;
    }
    editor.current?.action(callCommand(COMMAND_FOR[command].key));
    focusTheEditor(editor.current);
  };

  const makeTheLink = () => {
    if (!asking) return;
    const href = safeHref(asking.href);
    if (!href) {
      setAsking({ ...asking, refused: true });
      return;
    }
    setAsking(null);
    editor.current?.action(callCommand(toggleLinkCommand.key, { href }));
    focusTheEditor(editor.current);
  };

  return (
    <div className="mt-1 rounded-md border border-black/10 bg-white focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft/40">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-wrap gap-1 border-b border-black/10 px-2 py-1.5"
      >
        {(Object.keys(KEY_FOR) as Formatting[]).map((command) => (
          <button
            key={command}
            type="button"
            disabled={!editable || !ready}
            title={`${command} (${KEY_FOR[command].replace('Mod', modifierName())})`}
            onClick={() => apply(command)}
            className="rounded px-2 py-0.5 text-xs font-medium normal-case tracking-normal text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
          >
            {command}
          </button>
        ))}
      </div>

      {asking && editable && (
        <div className="flex flex-wrap items-center gap-2 border-b border-black/10 px-2 py-1.5">
          <input
            autoFocus
            aria-label="Address"
            value={asking.href}
            onChange={(event) => setAsking({ href: event.target.value, refused: false })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                makeTheLink();
              }
            }}
            placeholder="https://"
            className="min-w-0 flex-1 rounded border border-black/10 px-2 py-1 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={makeTheLink}
            className="rounded px-2 py-0.5 text-xs font-medium normal-case tracking-normal text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
          >
            Add link
          </button>
          {asking.refused && (
            <p
              role="alert"
              className="w-full text-xs font-normal normal-case tracking-normal text-over"
            >
              A link can only go to a web address or an email address.
            </p>
          )}
        </div>
      )}

      <div ref={host} className="max-h-96 overflow-y-auto px-3 py-2" />
    </div>
  );
}

/** What the platform calls the modifier, so a tooltip names the key that works. */
function modifierName(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Mac|iPhone|iPad/.test(platform) ? 'Cmd' : 'Ctrl';
}

function focusTheEditor(made: Editor | null) {
  made?.action((ctx) => ctx.get(editorViewCtx).focus());
}

/** The address already on the selection, so editing a link starts from it. */
function hrefUnderTheCursor(made: Editor | null): string | null {
  let found: string | null = null;
  made?.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { from, to } = view.state.selection;
    // A cursor covers nothing, so look one position past it - but never past
    // the end of the document, which `nodesBetween` refuses outright.
    const until = Math.min(from === to ? to + 1 : to, view.state.doc.content.size);
    view.state.doc.nodesBetween(from, until, (node) => {
      const mark = node.marks.find(({ type }) => type === linkSchema.type(ctx));
      if (mark) found = String(mark.attrs.href ?? '');
    });
  });
  return found;
}
