import { describe, expect, it } from 'vitest';
import {
  STARRED,
  cockpitLabelIn,
  conversationFrom,
  conversationPage,
  historyPage,
  labelChange,
  stillMarked,
} from '../../src/messages.js';
import { historyAnswer, historyRecord, labelsAnswer, modifyAnswer, plainThread, profileAnswer, threadsPage } from '../gmail-payloads.js';

/**
 * The contract tier: the calls the Gmail connector reads, and the one change
 * it writes (undone in the same case), asked of Gmail
 * itself against a dedicated test mailbox (docs/testing-strategy.md, "Third
 * parties"; "Bring in the conversations already labelled Cockpit as tasks",
 * issue 725), moved into the connector's package ("Build Gmail as a connector
 * package on the SDK, unregistered", issue 943; the core's copy went with
 * Gmail's code, issue 944). **Never per change** (.github/workflows/contract.yml), for
 * the reason the Bot Framework one is: it reaches the network, and what it
 * holds is Google's decision rather than ours.
 *
 * What only this tier can prove: that Gmail still answers in the shapes
 * tests/gmail-payloads.ts records - which every tier below is faked with, the
 * application's own Gmail-on-the-host cases among them - and
 * that the connector's own readers still make sense of a live answer. A
 * failure means those payloads describe a Gmail that no longer exists, and
 * updating them is priority work, never something to re-run until it passes.
 *
 * **It needs a mailbox of its own**: one with a label called Cockpit and at
 * least one conversation carrying it that has a subject and some text, signed
 * in to once through a Google client allowed `gmail.modify`, and that
 * sign-in's refresh token kept as a secret. Without the three secrets below it
 * skips, saying so, rather than reaching for anybody's real mail.
 */

const clientId = process.env.GMAIL_CONTRACT_CLIENT_ID ?? '';
const clientSecret = process.env.GMAIL_CONTRACT_CLIENT_SECRET ?? '';
const refreshToken = process.env.GMAIL_CONTRACT_REFRESH_TOKEN ?? '';
const provisioned = Boolean(clientId && clientSecret && refreshToken);

let accessToken: Promise<string> | null = null;

/** One access token for the run, refreshed as the connector refreshes it. */
function signedIn(): Promise<string> {
  accessToken ??= (async () => {
    const answer = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(answer.ok, `Google answered ${answer.status} to a refresh`).toBe(true);
    const { access_token: token } = (await answer.json()) as { access_token?: unknown };
    expect(typeof token).toBe('string');
    return token as string;
  })();
  return accessToken;
}

async function gmail(path: string): Promise<Record<string, unknown>> {
  const answer = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { authorization: `Bearer ${await signedIn()}` },
  });
  expect(answer.ok, `Gmail answered ${answer.status} to ${path.split('?')[0]}`).toBe(true);
  return (await answer.json()) as Record<string, unknown>;
}

/**
 * The fields a recorded payload carries, each with the type of its value -
 * arrays read through their first element - so a live answer can be held to
 * carry at least the same.
 */
function shapeOf(value: unknown, at = ''): Map<string, string> {
  const shape = new Map<string, string>();
  if (Array.isArray(value)) {
    shape.set(at, 'array');
    if (value.length > 0) for (const [path, type] of shapeOf(value[0], `${at}[]`)) shape.set(path, type);
  } else if (value && typeof value === 'object') {
    shape.set(at, 'object');
    for (const [key, inner] of Object.entries(value)) {
      for (const [path, type] of shapeOf(inner, at ? `${at}.${key}` : key)) shape.set(path, type);
    }
  } else {
    shape.set(at, typeof value);
  }
  return shape;
}

/** What the recorded payload has that the live answer lacks, or carries as another type. */
function missingFrom(live: unknown, recorded: unknown, reads: readonly string[]): string[] {
  const has = shapeOf(live);
  const wanted = shapeOf(recorded);
  return reads.filter((path) => has.get(path) !== wanted.get(path)).map((path) => `${path}: ${wanted.get(path)} wanted, ${has.get(path) ?? 'nothing'} found`);
}

describe.skipIf(!provisioned)('Capture', () => {
  describe('Gmail still answers the calls the connector reads in the shapes it reads', () => {
    it('lists labels with an id, a name and a type, one of them called Cockpit', async () => {
      const live = await gmail('labels');

      expect(missingFrom(live, labelsAnswer(), ['labels', 'labels[].id', 'labels[].name', 'labels[].type'])).toEqual([]);
      expect(cockpitLabelIn(live)).not.toBeNull();
    });

    it('gives a history position for the mailbox', async () => {
      const live = await gmail('profile');

      expect(missingFrom(live, profileAnswer(), ['emailAddress', 'historyId'])).toEqual([]);
    });

    it('lists what changed since a history position, restricted to the label, and answers 404 for one it no longer keeps', async () => {
      const labelId = cockpitLabelIn(await gmail('labels'))!;
      const { historyId } = await gmail('profile');
      const query = new URLSearchParams({ startHistoryId: String(historyId), labelId, maxResults: '1' });
      for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) query.append('historyTypes', type);

      // Nothing has changed since the position just read: a position and no records.
      const live = await gmail(`history?${query}`);

      expect(missingFrom(live, historyAnswer([]), ['historyId'])).toEqual([]);
      expect(historyPage(live, labelId).gained).toEqual([]);
      // The shape of a record is held to the recorded one only where the mailbox has any.
      const [record] = (live.history as unknown[] | undefined) ?? [];
      if (record) {
        expect(
          missingFrom({ history: [record] }, { history: [historyRecord('1', { labelled: 'm', threadId: 't', with: [labelId], labelIds: [labelId] })] }, [
            'history',
            'history[].id',
          ]),
        ).toEqual([]);
      }

      const answer = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=1`, {
        headers: { authorization: `Bearer ${await signedIn()}` },
      });
      expect(answer.status, 'Gmail no longer answers 404 to a position it does not keep').toBe(404);
    });

    // What a connection following the star reads ("Connect Gmail by star,
    // and bring in conversations starred from then on", issue 822): the same
    // history, restricted to Gmail's own label for the star.
    it('lists what changed since a history position, restricted to the star', async () => {
      const { historyId } = await gmail('profile');
      const query = new URLSearchParams({ startHistoryId: String(historyId), labelId: STARRED, maxResults: '1' });
      for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) query.append('historyTypes', type);

      const live = await gmail(`history?${query}`);

      expect(missingFrom(live, historyAnswer([]), ['historyId'])).toEqual([]);
      expect(historyPage(live, STARRED).gained).toEqual([]);
    });

    it('lists the conversations carrying the label, a page at a time, and reads one whole', async () => {
      const labelId = cockpitLabelIn(await gmail('labels'))!;
      const listed = await gmail(`threads?${new URLSearchParams({ labelIds: labelId, maxResults: '1' })}`);

      expect(missingFrom(listed, threadsPage(['a-thread'], 'a-page'), ['threads', 'threads[].id', 'resultSizeEstimate'])).toEqual([]);
      const [threadId] = conversationPage(listed).threadIds;
      expect(threadId).toBeTruthy();

      const thread = await gmail(`threads/${encodeURIComponent(threadId!)}?format=full`);
      expect(
        missingFrom(thread, plainThread('a-thread'), [
          'id',
          'messages',
          'messages[].id',
          'messages[].labelIds',
          'messages[].internalDate',
          'messages[].payload',
          'messages[].payload.mimeType',
          'messages[].payload.headers',
          'messages[].payload.headers[].name',
          'messages[].payload.headers[].value',
        ]),
      ).toEqual([]);
      const conversation = conversationFrom(thread, labelId, 'contract@example.com');
      expect(conversation?.title).toBeTruthy();
      expect(conversation?.text).toBeTruthy();
      expect(conversation?.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Read again as a check reads one whose label may have come off: each
      // message's labels, and no body ("Close a Gmail task when its label
      // comes off", issue 727).
      const minimal = await gmail(`threads/${encodeURIComponent(threadId!)}?format=minimal`);
      expect(missingFrom(minimal, plainThread('a-thread'), ['id', 'messages', 'messages[].id', 'messages[].labelIds'])).toEqual([]);
      expect(stillMarked(minimal, labelId)).toBe(true);
    });

    // What Cockpit changes in the mailbox ("Take the Cockpit label off in
    // Gmail when its task is done in Cockpit", issue 728). The label goes
    // back on whatever happens, so the mailbox ends as it started.
    it('takes the label off a conversation and puts it back, answering its labels each time', async () => {
      const labelId = cockpitLabelIn(await gmail('labels'))!;
      const [threadId] = conversationPage(await gmail(`threads?${new URLSearchParams({ labelIds: labelId, maxResults: '1' })}`)).threadIds;
      expect(threadId).toBeTruthy();
      const modify = (wanted: boolean) => gmailChanges(`threads/${encodeURIComponent(threadId!)}/modify`, labelChange(labelId, wanted));

      try {
        const off = await modify(false);
        expect(missingFrom(off, modifyAnswer(plainThread('a-thread')), ['id', 'messages', 'messages[].id', 'messages[].labelIds'])).toEqual([]);
        expect(stillMarked(off, labelId)).toBe(false);
        // Again, as a check that stopped before recording it asks again: no change, no refusal.
        expect(stillMarked(await modify(false), labelId)).toBe(false);
      } finally {
        expect(stillMarked(await modify(true), labelId)).toBe(true);
      }
    });
  });
});

async function gmailChanges(path: string, body: unknown): Promise<Record<string, unknown>> {
  const answer = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await signedIn()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(answer.ok, `Gmail answered ${answer.status} to ${path}`).toBe(true);
  return (await answer.json()) as Record<string, unknown>;
}

