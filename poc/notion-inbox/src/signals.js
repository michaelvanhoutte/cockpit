// Collecting the four signals, in one place.
//
// Both the probe battery (which judges whether they work) and the handled experiment
// (which watches what happens to them afterwards) read them through here, so the two
// cannot quietly disagree about what counts as a mention or a reply.
import { queryDataSource, retrieveDataSource, sameId } from './notion.js';
import {
    blockRichText, handledCandidates, mentionsUser, pageTitle, plainText,
    propertyNamesByType, readProperty,
} from './normalize.js';

/**
 * SIGNAL 1 — database rows whose people property contains me.
 *
 * The only signal with a real query behind it. Also probes the `"me"` shorthand once,
 * because it looks like the obvious way to write this filter and silently returns nothing:
 * it resolves to the authenticated user, which for an internal integration is the bot.
 */
export async function collectAssignments({ personUserId, dataSources }) {
    const databases = [];
    const assignments = [];
    let meTrap = null;

    for (const source of dataSources) {
        let schema = source.properties;
        if (!schema) {
            const { json, call } = await retrieveDataSource(source.id);
            if (!call.ok) {
                databases.push({ id: source.id, title: pageTitle(source), error: call.error, message: call.message });
                continue;
            }
            schema = json.properties;
        }

        const peopleProps = propertyNamesByType(schema, 'people');
        const handled = handledCandidates(schema);
        const title = pageTitle(source);

        if (!peopleProps.length) {
            databases.push({ id: source.id, title, peopleProperties: [], handledProperties: handled, skipped: 'no people property' });
            continue;
        }

        const control = await queryDataSource(source.id, { page_size: 1 });
        const matches = [];

        for (const property of peopleProps) {
            const { json, call } = await queryDataSource(source.id, {
                filter: { property, people: { contains: personUserId } },
                sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
                page_size: 50,
            });
            const rows = call.ok ? (json.results || []) : [];
            matches.push({ property, ok: call.ok, error: call.error, count: rows.length });

            for (const row of rows) {
                assignments.push({
                    id: row.id,
                    title: pageTitle(row),
                    url: row.url,
                    database: title,
                    databaseId: source.id,
                    property,
                    lastEdited: row.last_edited_time,
                    inTrash: row.in_trash ?? row.archived ?? false,
                    assignees: (row.properties?.[property]?.people || []).map((p) => p.id),
                    handledState: Object.fromEntries(handled.map((h) => [h.name, readProperty(row, h.name)])),
                });
            }
        }

        if (meTrap === null) {
            const { json, call } = await queryDataSource(source.id, {
                filter: { property: peopleProps[0], people: { contains: 'me' } },
                page_size: 5,
            });
            meTrap = { property: peopleProps[0], ok: call.ok, error: call.error, count: call.ok ? (json.results || []).length : 0 };
        }

        databases.push({
            id: source.id,
            title,
            peopleProperties: peopleProps,
            handledProperties: handled,
            hasRows: control.call.ok,
            matches,
        });
    }

    return { databases, assignments, meTrap };
}

/**
 * SIGNAL 2 — anything in a document whose rich_text carries a mention token with my user id.
 *
 * Two places, not one. Blocks are the obvious case. Page *properties* are the case that gets
 * missed: a database row referencing you in its title or a notes column frequently has no
 * blocks at all, so scanning only blocks reports a confident zero on exactly the rows where
 * the work lives. Both are folded into one signal here, tagged by `anchor`.
 */
export function collectPageMentions({ crawl, personUserId }) {
    const fromBlocks = crawl.allBlocks
        .filter(({ block }) => mentionsUser(blockRichText(block), personUserId))
        .map(({ block, page }) => ({
            blockId: block.id,
            anchor: 'block',
            blockType: block.type,
            pageId: page.id,
            pageTitle: pageTitle(page),
            url: page.url,
            text: plainText(blockRichText(block)),
            lastEdited: block.last_edited_time,
            authorId: block.last_edited_by?.id ?? block.created_by?.id ?? null,
            isTodo: block.type === 'to_do',
            checked: block.to_do?.checked ?? null,
        }));

    const fromProperties = (crawl.allProperties || [])
        .filter(({ property }) => mentionsUser(property.richText, personUserId))
        .map(({ property, page }) => ({
            // Properties have no block id, so the page id plus the property name is the stable
            // identity the handled-diff keys on.
            blockId: `${page.id}#${property.name}`,
            anchor: 'property',
            blockType: `property:${property.type}`,
            propertyName: property.name,
            pageId: page.id,
            pageTitle: pageTitle(page),
            url: page.url,
            text: plainText(property.richText),
            lastEdited: page.last_edited_time,
            authorId: page.last_edited_by?.id ?? page.created_by?.id ?? null,
            isTodo: false,
            checked: null,
        }));

    return [...fromBlocks, ...fromProperties];
}

/** SIGNAL 3 — comments whose rich_text mentions me. */
export function collectCommentMentions({ crawl, personUserId }) {
    return crawl.allComments
        .filter(({ comment }) => mentionsUser(comment.rich_text, personUserId))
        .map(({ comment, page }) => ({
            commentId: comment.id,
            discussionId: comment.discussion_id,
            anchor: comment.anchor ?? 'page',
            pageId: page.id,
            pageTitle: pageTitle(page),
            url: page.url,
            text: plainText(comment.rich_text),
            createdTime: comment.created_time,
            authorId: comment.created_by?.id ?? null,
            authorName: comment.display_name?.resolved_name ?? null,
        }));
}

/**
 * SIGNAL 4 — anything written after a comment of mine, in the same discussion, by
 * somebody else. There is no "threads I am in" query, so the thread has to be rebuilt
 * from `discussion_id` and then read in order.
 */
export function collectReplies({ crawl, personUserId }) {
    const byDiscussion = new Map();
    for (const { comment, page } of crawl.allComments) {
        if (!comment.discussion_id) continue;
        if (!byDiscussion.has(comment.discussion_id)) byDiscussion.set(comment.discussion_id, { page, comments: [] });
        byDiscussion.get(comment.discussion_id).comments.push(comment);
    }

    const replies = [];
    const mine = [];

    for (const [discussionId, { page, comments }] of byDiscussion) {
        const ordered = [...comments].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
        const firstMineAt = ordered.findIndex((c) => sameId(c.created_by?.id, personUserId));
        if (firstMineAt === -1) continue;
        mine.push(discussionId);

        for (const later of ordered.slice(firstMineAt + 1)) {
            if (sameId(later.created_by?.id, personUserId)) continue;
            replies.push({
                commentId: later.id,
                discussionId,
                pageId: page.id,
                pageTitle: pageTitle(page),
                url: page.url,
                text: plainText(later.rich_text),
                createdTime: later.created_time,
                authorId: later.created_by?.id ?? null,
                authorName: later.display_name?.resolved_name ?? null,
                threadLength: ordered.length,
            });
        }
    }

    return { replies, discussionsVisible: byDiscussion.size, discussionsInvolvingMe: mine.length };
}
