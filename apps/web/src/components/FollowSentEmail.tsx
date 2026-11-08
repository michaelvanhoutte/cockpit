import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SentEmailEntry } from '@cockpit/shared/sent-emails';
import { fetchSentEmails, followSentEmail } from '../api/sentEmails';
import { agoLabel } from '../conversationLine';

/**
 * *Follow a sent email…* in Capture ("Follow a sent email… in Capture", issue
 * 1710): the last ten emails sent from the Workspace's mail connections,
 * newest first, read from the sources when this opens; picking one makes an
 * Item that follows that conversation, Waiting for reply, titled with the
 * subject, and filed as a capture with *File on* would file it.
 *
 * **A chunk of its own**, fetched when the entry is first pressed, so Capture
 * pays nothing for it until then. It takes the place of the note while it is
 * open, which is what lets the list fill the Capture page on a phone.
 */
export function FollowSentEmail({
  workspaceId,
  decided,
  panelIds,
  onBack,
  onFollowed,
}: {
  workspaceId: string;
  /** Whether Capture's *Where* chose this Workspace, as a capture records it. */
  decided: boolean;
  /** The Panels Capture's *File on* chose. */
  panelIds: readonly string[];
  onBack: () => void;
  onFollowed: (followed: { itemId: string; subject: string; made: boolean }) => void;
}) {
  // Read afresh every time it opens: a sent email is news the moment it is sent.
  const sent = useQuery({
    queryKey: ['sent-emails', workspaceId],
    queryFn: () => fetchSentEmails(workspaceId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const [picking, setPicking] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const pick = async (email: SentEmailEntry) => {
    if (picking) return;
    setPicking(keyOf(email));
    setRefused(null);
    try {
      const { itemId, made } = await followSentEmail(workspaceId, {
        sourceAccountId: email.sourceAccountId,
        conversationId: email.conversationId,
        subject: email.subject,
        to: email.to,
        sentAt: email.sentAt,
        link: email.link,
        excerpt: email.excerpt,
        decided,
        ...(panelIds.length > 0 ? { panelIds: [...panelIds] } : {}),
      });
      onFollowed({ itemId, subject: email.subject, made });
    } catch (failure) {
      setRefused(failure instanceof Error ? failure.message : 'That email could not be followed. Try again.');
      setPicking(null);
    }
  };

  const now = Date.now();
  return (
    <section aria-label="Follow a sent email" data-follow-sent="" className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onBack}
          className="min-h-9 shrink-0 rounded-md border border-shade/10 bg-field px-3 text-sm text-ink-soft hover:border-accent hover:bg-accent-tint hover:text-ink sm:min-h-0 sm:px-2.5 sm:py-1 sm:text-[13px]"
        >
          ← Back to the note
        </button>
        <h2 className="text-sm font-semibold text-ink">Follow a sent email</h2>
      </div>
      <p className="text-sm text-ink-faint">
        Your last {sent.data?.emails.length ?? 10} sent emails, newest first. Pick one to follow its conversation: it waits for a reply.
      </p>

      {sent.isPending && <p role="status" className="text-sm text-ink-soft">Reading your sent emails…</p>}
      {sent.isError && (
        <p role="alert" className="text-sm text-over-ink">
          Your sent emails could not be read. Try again in a moment.
        </p>
      )}
      {sent.data?.failing.map((one) => (
        <p key={one.mailbox} role="alert" className="text-sm text-over-ink">
          {one.mailbox} could not be read: {one.why}
        </p>
      ))}
      {refused && (
        <p role="alert" className="text-sm text-over-ink">
          {refused}
        </p>
      )}
      {sent.data && sent.data.emails.length === 0 && sent.data.failing.length === 0 && (
        <p className="text-sm text-ink-soft">Nothing sent from the connected mailboxes yet.</p>
      )}

      {sent.data && sent.data.emails.length > 0 && (
        <ul className="flex flex-col divide-y divide-shade/8 overflow-hidden rounded-md border border-shade/10 bg-field">
          {sent.data.emails.map((email) => (
            <li key={keyOf(email)}>
              <button
                type="button"
                data-sent-email=""
                disabled={picking !== null}
                onClick={() => void pick(email)}
                className="flex min-h-14 w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent-tint disabled:opacity-50 sm:px-4"
              >
                <span className="w-full truncate text-[15px] font-medium text-ink">{email.subject}</span>
                <span className="w-full truncate text-sm text-ink-faint">
                  {email.to ? `To ${email.to}` : 'To nobody named'} · {agoLabel(email.sentAt, now)} · {email.mailbox}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const keyOf = (email: SentEmailEntry) => `${email.sourceAccountId}\u0000${email.conversationId}`;
