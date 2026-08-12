// Turns Notion objects into the things the probes measure and the row shape the
// Cockpit prototype renders.
import { sameId } from './notion.js';

/** Flattens a rich_text array to plain text. Mentions render as "@Name" here. */
export function plainText(richText) {
    return (richText || []).map((t) => t.plain_text ?? '').join('');
}

/**
 * Is this rich_text a *real* mention of the given user — a `mention` token carrying
 * their user id, not just their name typed as text?
 *
 * The distinction is the same one that mattered in the Slack POC, and it matters more
 * here: typing "Michael" notifies nobody, while a mention token does. Anything that
 * counts plain-text name matches will over-report an inbox into uselessness.
 */
export function mentionsUser(richText, userId) {
    return (richText || []).some(
        (t) => t.type === 'mention' && t.mention?.type === 'user' && sameId(t.mention.user?.id, userId)
    );
}

/** The same test, but for a name typed as ordinary text. Used to measure false positives. */
export function namedInText(richText, name) {
    if (!name) return false;
    return (richText || []).some((t) => t.type !== 'mention' && (t.plain_text || '').toLowerCase().includes(name.toLowerCase()));
}

// Block types that carry text. Everything else (images, dividers, breadcrumbs) has no
// rich_text and so can never hold a mention.
const TEXT_BEARING = [
    'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
    'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'code',
    'bookmark', 'embed', 'template', 'table_row',
];

/** The rich_text of a block, whatever its type. */
export function blockRichText(block) {
    const payload = block?.[block?.type];
    if (!payload) return [];
    if (Array.isArray(payload.rich_text)) return payload.rich_text;
    // table_row holds an array of cells, each of which is its own rich_text array.
    if (Array.isArray(payload.cells)) return payload.cells.flat();
    return [];
}

export const isTextBearing = (block) => TEXT_BEARING.includes(block?.type);

/** A to_do block is Notion's other kind of action item — one that has a checkbox. */
export const isCheckedTodo = (block) => block?.type === 'to_do' && block.to_do?.checked === true;

/** Page title, wherever the title property happens to be called. */
export function pageTitle(page) {
    if (page?.object === 'data_source' || page?.object === 'database') {
        const title = plainText(page.title);
        return title || '(untitled database)';
    }
    const props = page?.properties || {};
    for (const value of Object.values(props)) {
        if (value?.type === 'title') {
            const title = plainText(value.title);
            if (title) return title;
        }
    }
    return '(untitled)';
}

/** People-property values on a page, as user ids. */
export function peopleOn(page, propertyName) {
    const prop = page?.properties?.[propertyName];
    if (prop?.type !== 'people') return [];
    return (prop.people || []).map((p) => p.id);
}

/**
 * The properties that could carry a "handled" state. Cockpit needs one of these to
 * exist on a task database, otherwise there is nothing to watch for completion.
 */
export function handledCandidates(schema) {
    const out = [];
    for (const [name, prop] of Object.entries(schema || {})) {
        if (['status', 'checkbox', 'select'].includes(prop.type)) out.push({ name, type: prop.type });
    }
    return out;
}

export function propertyNamesByType(schema, type) {
    return Object.entries(schema || {}).filter(([, prop]) => prop.type === type).map(([name]) => name);
}

/** Reads a page's current value for one property, flattened enough to diff. */
export function readProperty(page, name) {
    const prop = page?.properties?.[name];
    if (!prop) return null;
    switch (prop.type) {
        case 'status': return prop.status?.name ?? null;
        case 'select': return prop.select?.name ?? null;
        case 'checkbox': return prop.checkbox === true;
        case 'people': return (prop.people || []).map((p) => p.id).sort().join(',');
        case 'date': return prop.date?.start ?? null;
        default: return null;
    }
}

// --- Cockpit rows ----------------------------------------------------------------

const ORIGIN_LABEL = {
    assignment: 'Assigned',
    'page-mention': 'Mention',
    'comment-mention': 'Comment',
    'comment-reply': 'Reply',
};

function shortTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 60) return `${Math.max(mins, 0)}m`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / (60 * 24))}d`;
}

/**
 * Notion has no per-comment deep link. A page carries a `url`; a comment carries only
 * ids, so the best Cockpit can do is link to the page the comment lives on and let the
 * user find the thread. Recorded honestly as `urlIsExact: false` rather than papered
 * over with a guessed anchor, because a link that silently lands in the wrong place is
 * worse than one that admits it is approximate.
 */
export function toCockpitItem({ origin, id, title, url, urlIsExact = true, from, text, isoTime, pageId, extra }) {
    return {
        id,
        origin,
        originLabel: ORIGIN_LABEL[origin] || origin,
        title,
        action: text || title,
        from: from || 'unknown',
        url: url || null,
        urlIsExact,
        pageId: pageId || null,
        isoTime: isoTime || null,
        time: shortTime(isoTime),
        ...(extra || {}),
    };
}

export function mergeItems(groups) {
    const byId = new Map();
    for (const item of groups.flat()) {
        if (!byId.has(item.id)) byId.set(item.id, item);
    }
    return [...byId.values()].sort((a, b) => String(b.isoTime).localeCompare(String(a.isoTime)));
}
