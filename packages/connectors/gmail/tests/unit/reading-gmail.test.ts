import { describe, expect, it } from 'vitest';
import {
  cockpitLabelIn,
  conversationFrom,
  historyPage,
  labelChange,
  labelChangeRefusal,
  stillMarked,
} from '../../src/messages.js';
import { COCKPIT_LABEL_ID, historyAnswer, historyRecord, labelsAnswer, message, threadAnswer } from '../gmail-payloads.js';

/**
 * L1: what Gmail's answers are read to mean - the conversation an Item is made
 * from, what a history page says changed, which label is Cockpit's and which
 * refusals of a label change are worth asking again. Pure: each takes an answer
 * already parsed ("Build Gmail as a connector package on the SDK,
 * unregistered", issue 943; ported from the core's own tests of the same
 * readers, which stay until Gmail leaves it).
 */

describe('Capture', () => {
  describe('an Item from Gmail carries the conversation’s subject, text, sender and link, as a Task', () => {
    const address = 'anna@example.com';
    it.each([
      {
        situation: 'a plain-text message',
        thread: threadAnswer('t-plain', [
          message('t-plain', {
            id: 'm1',
            sentAt: '2026-10-01T08:30:00Z',
            subject: 'Quarterly figures',
            from: '"Pieter Claes" <pieter@example.com>',
            plain: 'Send the Q3 figures\r\nbefore Friday.',
          }),
        ]),
        becomes: {
          title: 'Quarterly figures',
          text: 'Send the Q3 figures\nbefore Friday.',
          sender: 'Pieter Claes',
          sentAt: '2026-10-01T08:30:00.000Z',
        },
      },
      {
        situation: 'an HTML-only message',
        thread: threadAnswer('t-html', [
          message('t-html', {
            id: 'm1',
            sentAt: '2026-10-01T08:30:00Z',
            subject: 'Lunch',
            from: 'lotte@example.com',
            html: '<html><head><style>p{color:red}</style></head><body><p>Lunch on <b>Thursday</b>?</p><p>Fish &amp; chips&nbsp;&#8212; Lotte</p></body></html>',
          }),
        ]),
        becomes: { title: 'Lunch', text: 'Lunch on Thursday?\nFish & chips — Lotte', sender: 'lotte@example.com' },
      },
      {
        situation: 'a message with both parts, whose plain text is read',
        thread: threadAnswer('t-both', [
          message('t-both', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', subject: 'Both', plain: 'Plain words', html: '<p>HTML words</p>' }),
        ]),
        becomes: { title: 'Both', text: 'Plain words', sender: 'Pieter Claes' },
      },
      {
        situation: 'several labelled messages, and a reply after them that is not',
        thread: threadAnswer('t-many', [
          message('t-many', { id: 'm1', sentAt: '2026-10-01T08:00:00Z', subject: 'Contract', plain: 'First draft' }),
          message('t-many', { id: 'm2', sentAt: '2026-10-02T08:00:00Z', subject: 'Re: Contract', plain: 'Signed version' }),
          message('t-many', {
            id: 'm3',
            sentAt: '2026-10-03T08:00:00Z',
            subject: 'Re: Contract',
            plain: 'Thanks!',
            labelled: false,
          }),
        ]),
        becomes: { title: 'Re: Contract', text: 'Signed version', sentAt: '2026-10-02T08:00:00.000Z' },
      },
      {
        situation: 'no subject',
        thread: threadAnswer('t-none', [message('t-none', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', plain: 'Untitled words' })]),
        becomes: { title: '(no subject)', text: 'Untitled words' },
      },
      {
        situation: 'no text at all',
        thread: threadAnswer('t-empty', [message('t-empty', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', subject: 'Only a subject', plain: '' })]),
        becomes: { title: 'Only a subject', text: 'Only a subject' },
      },
      {
        situation: 'text that cannot be read',
        thread: threadAnswer('t-garbled', [
          ((sent) => ({ ...sent, payload: { ...sent.payload, body: { size: 3, data: '%%%' } } }))(
            message('t-garbled', { id: 'm1', sentAt: '2026-10-01T08:30:00Z', subject: 'Garbled', plain: 'unused' }),
          ),
        ]),
        becomes: { title: 'Garbled', text: 'Garbled' },
      },
    ])('$situation', ({ thread, becomes }) => {
      const conversation = conversationFrom(thread, COCKPIT_LABEL_ID, address);

      expect(conversation).toMatchObject({ threadId: thread.id, ...becomes });
      expect(conversation!.link).toBe(`https://mail.google.com/mail/?authuser=anna%40example.com#all/${thread.id}`);
    });
  });
});

describe('Capture', () => {
  describe('a history page is read into the conversations that gained the label', () => {
    const labelled = ['INBOX', COCKPIT_LABEL_ID];
    it.each([
      {
        situation: 'a label added to an old conversation',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled })],
        gained: ['t-old'],
      },
      {
        situation: 'a new message arriving already labelled, as a filter does it',
        records: [historyRecord('11', { added: 'm2', threadId: 't-new', labelIds: labelled })],
        gained: ['t-new'],
      },
      {
        situation: 'a reply in a conversation already labelled, arriving without the label',
        records: [historyRecord('11', { added: 'm3', threadId: 't-old', labelIds: ['INBOX', 'UNREAD'] })],
        gained: [],
      },
      {
        situation: 'the label added and taken off again within the page',
        records: [
          historyRecord('11', { labelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled }),
          historyRecord('12', { unlabelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: ['INBOX'] }),
        ],
        gained: [],
      },
      {
        situation: 'another label added',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-old', with: ['STARRED'], labelIds: ['INBOX', 'STARRED'] })],
        gained: [],
      },
      {
        situation: 'two messages of one conversation labelled',
        records: [
          historyRecord('11', { labelled: 'm1', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled }),
          historyRecord('12', { labelled: 'm2', threadId: 't-old', with: [COCKPIT_LABEL_ID], labelIds: labelled }),
        ],
        gained: ['t-old'],
      },
      { situation: 'nothing having changed', records: [], gained: [] },
    ])('reads $situation as $gained', ({ records, gained }) => {
      expect(historyPage(historyAnswer(records), COCKPIT_LABEL_ID).gained).toEqual(gained);
    });

    it('carries the mailbox’s position, and where the next page starts', () => {
      expect(historyPage(historyAnswer([], { historyId: '99', nextPageToken: 'more' }), COCKPIT_LABEL_ID)).toMatchObject({
        historyId: '99',
        nextPageToken: 'more',
      });
      expect(historyPage(historyAnswer([], { historyId: '99' }), COCKPIT_LABEL_ID).nextPageToken).toBeNull();
    });
  });

  describe('a history page names every conversation whose label it may have taken off or put back', () => {
    const labelled = ['INBOX', COCKPIT_LABEL_ID];
    it.each([
      {
        situation: 'the label removed',
        records: [historyRecord('11', { unlabelled: 'm1', threadId: 't-off', with: [COCKPIT_LABEL_ID], labelIds: ['INBOX'] })],
        changed: ['t-off'],
      },
      {
        situation: 'a labelled message moved to the bin',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-bin', with: ['TRASH'], labelIds: ['TRASH', COCKPIT_LABEL_ID] })],
        changed: ['t-bin'],
      },
      {
        situation: 'a labelled message taken out of the bin',
        records: [historyRecord('11', { unlabelled: 'm1', threadId: 't-back', with: ['TRASH'], labelIds: labelled })],
        changed: ['t-back'],
      },
      {
        situation: 'a message deleted for good',
        records: [historyRecord('11', { deleted: 'm1', threadId: 't-gone' })],
        changed: ['t-gone'],
      },
      {
        situation: 'the label added again',
        records: [historyRecord('11', { labelled: 'm1', threadId: 't-again', with: [COCKPIT_LABEL_ID], labelIds: labelled })],
        changed: ['t-again'],
      },
      {
        situation: 'another label added or removed',
        records: [
          historyRecord('11', { labelled: 'm1', threadId: 't-star', with: ['STARRED'], labelIds: ['STARRED', COCKPIT_LABEL_ID] }),
          historyRecord('12', { unlabelled: 'm1', threadId: 't-star', with: ['UNREAD'], labelIds: labelled }),
        ],
        changed: [],
      },
      {
        situation: 'a reply arriving without the label',
        records: [historyRecord('11', { added: 'm3', threadId: 't-old', labelIds: ['INBOX', 'UNREAD'] })],
        changed: [],
      },
    ])('reads $situation as $changed', ({ records, changed }) => {
      expect(historyPage(historyAnswer(records), COCKPIT_LABEL_ID).changed).toEqual(changed);
    });
  });

  describe('a conversation counts as labelled while a message carrying the label is outside the bin', () => {
    it.each([
      { situation: 'one labelled message', messages: [{ labelled: true }], counts: true },
      { situation: 'the label taken off its only message', messages: [{ labelled: false }], counts: false },
      { situation: 'its only labelled message in the bin', messages: [{ labelled: true, trashed: true }], counts: false },
      {
        situation: 'one labelled message binned and another still labelled',
        messages: [{ labelled: true, trashed: true }, { labelled: true }],
        counts: true,
      },
      { situation: 'no messages left', messages: [], counts: false },
    ])('$situation: $counts', ({ messages, counts }) => {
      const thread = threadAnswer(
        't',
        messages.map((one, at) => message('t', { id: `m${at}`, sentAt: '2026-10-01T08:30:00Z', plain: 'x', ...one })),
      );
      expect(stillMarked(thread, COCKPIT_LABEL_ID)).toBe(counts);
    });
  });

  describe('taking the label off a conversation or putting it back touches the Cockpit label alone', () => {
    it.each([
      { situation: 'taking it off', wanted: false, change: { removeLabelIds: [COCKPIT_LABEL_ID] } },
      { situation: 'putting it back', wanted: true, change: { addLabelIds: [COCKPIT_LABEL_ID] } },
    ])('$situation', ({ wanted, change }) => {
      expect(labelChange(COCKPIT_LABEL_ID, wanted)).toEqual(change);
    });
  });

  describe('a label change Gmail only holds back is asked again, and one it will never take is not', () => {
    const because = (reason: string) => ({ error: { code: 403, errors: [{ domain: 'usageLimits', reason }] } });
    it.each([
      { situation: '429', status: 429, answer: null, refusal: 'later' },
      { situation: '403 for the user’s rate limit', status: 403, answer: because('userRateLimitExceeded'), refusal: 'later' },
      { situation: '403 for the project’s rate limit', status: 403, answer: because('rateLimitExceeded'), refusal: 'later' },
      { situation: '503', status: 503, answer: null, refusal: 'later' },
      { situation: '403 for want of permission', status: 403, answer: because('insufficientPermissions'), refusal: 'never' },
      { situation: '403 with no reason', status: 403, answer: null, refusal: 'never' },
      { situation: '400', status: 400, answer: { error: { code: 400, message: 'Invalid label' } }, refusal: 'never' },
    ] as const)('$situation: $refusal', ({ status, answer, refusal }) => {
      expect(labelChangeRefusal(status, answer)).toBe(refusal);
    });
  });
});

describe('Connector management', () => {
  describe('a Gmail connection following the label is checked only where the mailbox has a label called Cockpit', () => {
    it.each([
      { situation: 'a label called Cockpit', answer: labelsAnswer(), finds: COCKPIT_LABEL_ID },
      { situation: 'one called cockpit, Gmail keeping names whatever their case', answer: labelsAnswer({ named: 'cockpit' }), finds: COCKPIT_LABEL_ID },
      { situation: 'no such label', answer: labelsAnswer({ cockpit: false }), finds: null },
      { situation: 'a label whose name only starts Cockpit', answer: labelsAnswer({ named: 'Cockpit/Later' }), finds: null },
      { situation: 'an answer with no labels in it', answer: {}, finds: null },
    ])('finds $situation', ({ answer, finds }) => {
      expect(cockpitLabelIn(answer)).toBe(finds);
    });
  });
});
