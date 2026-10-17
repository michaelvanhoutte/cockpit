import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import {
  CLAUDE_DESTINATIONS,
  MAX_CLAUDE_LINK_LENGTH,
  attachmentLinksSchema,
  CLAUDE_DESTINATION_NAMES,
  claudeLinkFor,
  isClaudeAction,
  messageFrom,
  plainPromptFor,
  proposedPromptFor,
  uuidv7,
  type Attachment,
  type ClaudeDestination,
  type Item,
  type ProposedFrom,
} from '@cockpit/shared';
import { CommandRefused, api, refusal } from '../api/client';
import { useSendCommand } from '../api/queries';
import { openClaude } from '../openClaude';
import { connectedAppsQuery } from './ManageConnectedApps';
import { capturingApp, sourceNamed, type SourceNames } from '../itemSource';

/**
 * The addresses a Claude session opens an Item's files at, for the prompt. Read
 * here rather than in `api/client.ts` with the rest, for the reason
 * `ManageConnectedApps` keeps its reads: only this window asks, and it is not
 * the initial bundle's to carry (`bundle:budget`).
 */
async function fetchAttachmentLinks(attachmentIds: readonly string[]): Promise<Record<string, string>> {
  if (attachmentIds.length === 0) return {};
  const res = await api.v1['attachment-links'].$post({ json: { attachmentIds: [...attachmentIds] } });
  if (!res.ok) throw refusal('file links', res.status);
  return attachmentLinksSchema.parse(await res.json()).links;
}

/** Where the last folder sent to is remembered, per viewer - a convenience that works without it. */
const FOLDER_KEY = 'cockpit.claudeFolder';

function lastFolder(): string {
  try {
    return window.localStorage.getItem(FOLDER_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberFolder(folder: string): void {
  try {
    window.localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    // Not remembered; typed again next time.
  }
}

/**
 * The review window over the screen ("Send an item to Cowork or Claude Code
 * with its prompt reviewed first", issue 1159): a Cowork | Code switch, a
 * folder, the prompt to edit, and what goes along. **Open in Cowork ↗** records
 * the Run as *Sent* and only then opens Claude's desktop app with exactly this
 * prompt and folder, so a send the server refused opens nothing.
 *
 * **It opens on what Cockpit proposed** ("Propose what to do with each item
 * before you look", issue 1161): the switch, the folder and the prompt set to
 * the first proposed action, the others offered beside it. Where nothing is
 * proposed yet, or nothing to do, it starts on the plain prompt built from the
 * Item's words - never waiting for a proposal. Either way the prompt carries a
 * link to each of the Item's files, and is shown once those links are made:
 * the textarea would otherwise be rewritten under the cursor. Where the links
 * cannot be made, the files are named instead and the prompt says so.
 *
 * **An Item someone else sent says so beside the proposal, and the prompt opens
 * with it** (`proposedPromptFor`, `plainPromptFor`), proposed or not: its words
 * are theirs.
 */
export function SendToClaudeWindow({
  item,
  workspaceId,
  attachments,
  onClose,
  returnFocusTo,
  sourceNames,
}: {
  item: Pick<Item, 'id' | 'title' | 'description' | 'claudeProposals' | 'source' | 'sender'>;
  workspaceId: string;
  attachments: readonly Pick<Attachment, 'id' | 'filename' | 'contentType'>[];
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
  sourceNames?: SourceNames;
}) {
  const send = useSendCommand();
  // One Run id for this window: the prompt names it, and an Open pressed
  // twice is the same Run, not two.
  const [runId] = useState(() => uuidv7());
  // What was proposed when the window opened, which does not change under it.
  const [proposals] = useState(() => item.claudeProposals ?? []);
  const actions = proposals.filter(isClaudeAction);
  const nothing = proposals.find((one) => one.destination === 'nothing');
  const [chosen, setChosen] = useState(0);
  const action = actions[chosen];
  const [destination, setDestination] = useState<ClaudeDestination>(actions[0]?.destination ?? 'cowork');
  // A proposal's own folder, empty included - it decided none fits, so Claude
  // asks; empty too where it proposed nothing to do, and the folder last sent
  // to only where nothing has been proposed yet.
  const [folder, setFolder] = useState(() => (actions[0] ? actions[0].folder : nothing ? '' : lastFolder()));
  const [edited, setEdited] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const links = useQuery({
    queryKey: ['attachmentLinks', item.id, attachments.map((attachment) => attachment.id)],
    queryFn: () => fetchAttachmentLinks(attachments.map((attachment) => attachment.id)),
    retry: false,
    // A link works for an hour: never reuse one from an earlier opening.
    staleTime: 0,
    gcTime: 0,
  });
  const ready = !links.isPending;
  const apps = useQuery(connectedAppsQuery);

  // Where an Item someone else sent came from; an app's capture is named by the app alone.
  const from: ProposedFrom | null =
    item.source === 'internal'
      ? null
      : { source: capturingApp(item) ?? sourceNamed(sourceNames, item.source), sender: item.source === 'mcp' ? null : item.sender };
  const linked = attachments.map((attachment) => ({ ...attachment, link: links.data?.[attachment.id] }));
  const plain = action
    ? proposedPromptFor({ prompt: action.prompt, runId, attachments: linked, from })
    : plainPromptFor({ title: item.title, description: item.description, runId, attachments: linked, from });
  const prompt = edited ?? plain;

  /** Another proposed action: its destination, its folder and its prompt, in place of what was there. */
  const choose = (at: number) => {
    const next = actions[at];
    if (!next) return;
    setChosen(at);
    setDestination(next.destination);
    setFolder(next.folder);
    setEdited(null);
  };
  const name = CLAUDE_DESTINATION_NAMES[destination];
  const link = claudeLinkFor(destination, prompt.trim(), folder);
  const tooLong = link.length > MAX_CLAUDE_LINK_LENGTH;
  const canOpen = ready && !sending && prompt.trim().length > 0 && !tooLong;
  const noAppConnected = apps.data !== undefined && apps.data.apps.length === 0;

  const open = async () => {
    if (!canOpen) return;
    setSending(true);
    setRefusal(null);
    const chosen = folder.trim();
    try {
      await send({
        name: 'send_item_to_claude',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId: item.id,
          runId,
          destination,
          folder: chosen,
        },
      });
    } catch (failure) {
      setRefusal(failure instanceof CommandRefused ? failure.message : 'That did not reach the server. Try again.');
      setSending(false);
      return;
    }
    // A proposal sent with no folder keeps the one remembered, which an Item
    // with no proposal yet still opens on.
    if (chosen !== '' || proposals.length === 0) rememberFolder(chosen);
    openClaude(claudeLinkFor(destination, prompt.trim(), chosen));
    onClose();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(stillOpen) => {
        if (!stillOpen && !sending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-1/2 flex max-h-[calc(100vh-2rem)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="truncate text-base font-semibold">Send “{item.title}” to Claude</Dialog.Title>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void open();
            }}
          >
            {actions.length > 1 && (
              <div role="radiogroup" aria-label="Proposed" className="mt-4 flex flex-col gap-1">
                <span className="text-sm text-ink-soft">
                  Cockpit proposes {actions.length} things to do{from ? `, from ${messageFrom(from)}` : ''}
                </span>
                {actions.map((one, at) => (
                  <button
                    key={at}
                    type="button"
                    role="radio"
                    aria-checked={chosen === at}
                    disabled={sending}
                    onClick={() => choose(at)}
                    className={`rounded-md border px-3 py-1.5 text-left text-sm ${
                      chosen === at ? 'border-accent bg-accent-tint text-accent-deep' : 'border-shade/10 text-ink-soft hover:bg-accent-tint'
                    }`}
                  >
                    {one.label} <span className="text-ink-faint">· {CLAUDE_DESTINATION_NAMES[one.destination]}</span>
                  </button>
                ))}
              </div>
            )}

            {actions.length === 1 && from && (
              <p className="mt-4 text-sm text-ink-soft">Cockpit proposes this from {messageFrom(from)}. Check what it asks before you send.</p>
            )}

            {nothing && (
              <div className="mt-4 rounded-md bg-accent-tint px-3 py-2 text-sm text-ink-soft">
                <p>Cockpit proposes nothing to do. You can still send it as it is.</p>
                {/* The model's reason, quoted and set apart rather than said in Cockpit's own voice. */}
                <p className="mt-1 text-ink-faint">
                  Why: <q className="italic">{nothing.why}</q>
                </p>
              </div>
            )}

            <div role="radiogroup" aria-label="Send to" className="mt-4 inline-flex rounded-md border border-shade/10 p-0.5">
              {CLAUDE_DESTINATIONS.map((one) => (
                <button
                  key={one}
                  type="button"
                  role="radio"
                  aria-checked={destination === one}
                  disabled={sending}
                  onClick={() => setDestination(one)}
                  className={`rounded px-3 py-1 text-sm ${
                    destination === one ? 'bg-accent text-on-accent' : 'text-ink-soft hover:bg-accent-tint'
                  }`}
                >
                  {CLAUDE_DESTINATION_NAMES[one]}
                </button>
              ))}
            </div>

            <label className="mt-4 block text-sm text-ink-soft">
              Folder
              <input
                value={folder}
                disabled={sending}
                onChange={(event) => setFolder(event.target.value)}
                placeholder="C:\GitHub\Cockpit"
                maxLength={1000}
                className="mt-1 w-full rounded-md border border-shade/10 bg-field px-3 py-1.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>

            <label className="mt-4 block text-sm text-ink-soft">
              Prompt
              <textarea
                autoFocus
                value={ready ? prompt : ''}
                placeholder={ready ? undefined : 'Making links to the files…'}
                disabled={sending || !ready}
                onChange={(event) => setEdited(event.target.value)}
                rows={10}
                maxLength={100_000}
                className="mt-1 w-full resize-y rounded-md border border-shade/10 bg-field px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>

            <p className="mt-3 text-sm text-ink-faint">
              Goes along: {action ? 'the proposed task' : 'the item’s words'}
              {attachments.length > 0 ? `, ${attachments.length === 1 ? 'a link to' : 'links to'} ${attachments
                .map((attachment) => attachment.filename)
                .join(', ')}` : ''}
              , and a closing that stops Claude before it sends, posts, buys or confirms anything.
            </p>

            {noAppConnected && (
              <p role="status" className="mt-3 rounded-md bg-due-soft px-3 py-2 text-sm text-due-ink">
                No app is connected under Settings › MCP, so this row will not follow the work. You can still
                open it in {name}; connect Claude there first to have the row follow it.
              </p>
            )}

            {tooLong && (
              <p role="alert" className="pt-3 text-sm text-over-ink">
                This prompt is too long to open in Claude. Shorten it, or send the files by their links alone.
              </p>
            )}

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over-ink">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                type="button"
                disabled={sending}
                className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canOpen}
                className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Open in {name} ↗
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Also the default export, for the lazy `import()` the list loads this behind.
export default SendToClaudeWindow;
