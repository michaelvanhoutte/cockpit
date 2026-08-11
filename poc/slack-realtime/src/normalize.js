// Slack search result -> the row shape Cockpit's prototype already renders
// (see app.js ITEMS: { id, src, from, subject, time, action, summary, status, url }).
// Slack's documented response only guarantees author info, content, permalink and
// context, so every field is read defensively through a list of candidate keys.
import { tsToDate } from './slack.js';

function pick(obj, ...paths) {
    for (const path of paths) {
        let cur = obj;
        for (const key of path.split('.')) {
            if (cur == null) break;
            cur = cur[key];
        }
        if (cur !== undefined && cur !== null && cur !== '') return cur;
    }
    return undefined;
}

// Confirmed against a live response, which returns:
//   author_name, author_user_id, team_id, channel_id, channel_name,
//   message_ts, content, is_author_bot, permalink
// The alternate keys are kept as fallbacks in case the shape varies by plan.
export function messageFields(msg) {
    return {
        ts: pick(msg, 'message_ts', 'ts', 'timestamp'),
        text: pick(msg, 'content', 'text', 'message.text'),
        permalink: pick(msg, 'permalink', 'link', 'url'),
        channelId: pick(msg, 'channel_id', 'channel.id', 'channel'),
        channelName: pick(msg, 'channel_name', 'channel.name'),
        channelType: pick(msg, 'channel_type', 'channel.type'),
        isIm: pick(msg, 'is_im', 'channel.is_im'),
        authorId: pick(msg, 'author_user_id', 'user', 'author.id', 'author_id', 'user_id'),
        authorName: pick(msg, 'author_name', 'author.display_name', 'author.real_name', 'username', 'user_name'),
        // Slackbot broadcasts and app notices arrive here too. They are not follow-up items.
        isBot: pick(msg, 'is_author_bot', 'bot_id') === true || pick(msg, 'bot_id') !== undefined,
        threadTs: pick(msg, 'thread_ts', 'message.thread_ts'),
    };
}

/**
 * Does this message text contain a real Slack mention of `userId`?
 *
 * Confirmed against a live response: the search API renders mentions as
 * `<@U0BNUKXK92B|Michael Vanhoutte>`, with the display name appended after a pipe,
 * not as the bare `<@U0BNUKXK92B>` token you write in the Slack composer. Matching
 * on the bare token therefore misses every genuine mention.
 */
export function mentionsUser(text, userId) {
    if (!text || !userId) return false;
    return new RegExp(`<@${userId}(\\||>)`).test(String(text));
}

function relativeTime(date) {
    if (!date) return '—';
    const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h`;
    if (diffMin < 60 * 24 * 7) return `${Math.round(diffMin / 1440)}d`;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Slack returns its own markup in `content`, so a row built straight from it reads
 * as "<@U0BNUKXK92B|Michael Vanhoutte> test1". Unwrap the three forms that show up
 * in practice: user mentions, channel links, and labelled URLs.
 */
export function renderSlackText(text) {
    return String(text || '')
        .replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, '@$2')
        .replace(/<@([UW][A-Z0-9]+)>/g, '@$1')
        .replace(/<#(C[A-Z0-9]+)\|([^>]+)>/g, '#$2')
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
        .replace(/<(https?:\/\/[^>]+)>/g, '$1');
}

function firstSentence(text, max = 110) {
    const clean = renderSlackText(text).replace(/\s+/g, ' ').trim();
    if (!clean) return '(no text)';
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * @param {object} msg raw Slack search result
 * @param {'dm'|'mention'} kind which probe found it
 */
export function toCockpitItem(msg, kind) {
    const f = messageFields(msg);
    const date = tsToDate(f.ts);
    const isDm = kind === 'dm' || f.isIm === true || f.channelType === 'im';
    const author = f.authorName || f.authorId || 'Unknown';
    const channel = f.channelName ? `#${String(f.channelName).replace(/^#/, '')}` : (f.channelId || 'unknown channel');

    return {
        id: `slack-${f.ts || Math.random().toString(36).slice(2)}`,
        src: 'slack',
        origin: kind,
        isBot: f.isBot === true,
        from: isDm ? `DM · ${author}` : `${channel} · ${author}`,
        subject: firstSentence(f.text, 48),
        time: relativeTime(date),
        isoTime: date ? date.toISOString() : null,
        // The prototype shows an AI-drafted next action. The POC has no model in the
        // loop, so it carries the raw text through and leaves the drafting to Cockpit.
        action: firstSentence(f.text),
        summary: firstSentence(f.text, 400),
        due: 'none',
        status: 'inbox',
        unseen: true,
        url: f.permalink || null,
    };
}

export function toCockpitItems(messages, kind) {
    return messages.map((m) => toCockpitItem(m, kind));
}
