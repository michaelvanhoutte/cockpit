// The crawler, which is the load-bearing part of this POC.
//
// Slack let Cockpit *ask* for mentions. Notion cannot: POST /v1/search matches page and
// data-source titles only, and GET /v1/comments takes one block id at a time. There is no
// query that means "mentions of me" or "comments involving me" anywhere in the API. So
// the only way to build those two signals is to enumerate what the integration can reach
// and read it, which turns a search problem into a sweep problem.
//
// That makes the request count a first-class measurement rather than an implementation
// detail, and it is why every function here reports its cost.
import { config } from './config.js';
import { blockChildren, listComments, paginate, search } from './notion.js';
import { isTextBearing, pageTitle } from './normalize.js';

/**
 * Everything the integration can see. This is also the honest measure of reach: a Notion
 * connection sees only what has been explicitly shared with it, unlike a Slack user token
 * which sees whatever the user sees.
 */
export async function reachable({ log = () => {} } = {}) {
    log('  search: pages');
    const pages = await paginate(
        (cursor) => search({
            filter: { property: 'object', value: 'page' },
            sort: { direction: 'descending', timestamp: 'last_edited_time' },
            page_size: 100,
            start_cursor: cursor,
        }),
        { max: config.maxPages }
    );

    log('  search: data sources');
    const dataSources = await paginate(
        (cursor) => search({
            filter: { property: 'object', value: 'data_source' },
            page_size: 100,
            start_cursor: cursor,
        })
    );

    return { pages, dataSources };
}

/**
 * The text-bearing *properties* of a page — its title and any rich_text columns.
 *
 * Easy to overlook and measured to matter: a database row that references you usually does
 * so in its title or in a notes column, not in a block. Such a row often has no blocks at
 * all, so a block-only crawl finds nothing there and reports a confident zero. Search already
 * returned these page objects in full, so scanning them costs no extra requests.
 */
export function pageProperties(page) {
    const out = [];
    for (const [name, prop] of Object.entries(page?.properties || {})) {
        const richText = prop.type === 'title' ? prop.title : prop.type === 'rich_text' ? prop.rich_text : null;
        if (richText?.length) out.push({ name, type: prop.type, richText });
    }
    return out;
}

/**
 * Walks a page's blocks depth-first, collecting every block that carries text.
 *
 * Skips child_page and child_database blocks on purpose: search already returns those as
 * pages in their own right, so recursing into them would double-count and blow the budget.
 */
export async function pageBlocks(pageId, { depth = config.maxBlockDepth } = {}) {
    const blocks = [];
    let requests = 0;
    let truncated = false;

    async function walk(blockId, level) {
        const page = await paginate((cursor) => blockChildren(blockId, cursor));
        requests += page.pages;
        if (!page.ok) return;

        for (const block of page.results) {
            if (block.type === 'child_page' || block.type === 'child_database') continue;
            if (isTextBearing(block) || block.type === 'to_do') blocks.push(block);
            if (block.has_children) {
                if (level < depth) await walk(block.id, level + 1);
                else truncated = true;
            }
        }
    }

    await walk(pageId, 1);
    return { blocks, requests, truncated };
}

/**
 * Comments on a page.
 *
 * `block_id` set to the page id returns the page-level discussions. Inline comments are
 * anchored to individual blocks, so finding those means one request *per block* — which is
 * why deep mode is opt-in and why its cost is reported separately. On a page of 40 blocks
 * that is 40 requests to answer "did anyone comment on me here", at ~3 requests/second.
 */
export async function pageComments(pageId, blocks, { deep = config.deepComments } = {}) {
    const comments = [];
    let requests = 0;
    let blocksProbed = 0;

    const atPage = await paginate((cursor) => listComments(pageId, cursor));
    requests += atPage.pages;
    if (atPage.ok) comments.push(...atPage.results.map((c) => ({ ...c, anchor: 'page' })));

    if (deep) {
        for (const block of blocks) {
            const atBlock = await paginate((cursor) => listComments(block.id, cursor));
            requests += atBlock.pages;
            blocksProbed += 1;
            if (atBlock.ok) comments.push(...atBlock.results.map((c) => ({ ...c, anchor: 'block', blockId: block.id })));
        }
    }

    return { comments, requests, blocksProbed, ok: atPage.ok, error: atPage.error, message: atPage.message };
}

/**
 * One full sweep: every reachable page, its text blocks, and its comments. Returns the
 * raw material for the mention, comment-mention and reply probes, plus what it cost.
 */
export async function crawlWorkspace({ log = () => {} } = {}) {
    const startedAt = Date.now();
    const { pages, dataSources } = await reachable({ log });

    const perPage = [];
    let blockRequests = 0;
    let commentRequests = 0;
    let depthTruncated = 0;
    let commentAccessError = null;

    for (const [index, page] of pages.results.entries()) {
        log(`  crawl ${index + 1}/${pages.results.length}: ${pageTitle(page)}`);
        const { blocks, requests: br, truncated } = await pageBlocks(page.id);
        blockRequests += br;
        if (truncated) depthTruncated += 1;

        const { comments, requests: cr, blocksProbed, ok, error, message } = await pageComments(page.id, blocks);
        commentRequests += cr;
        if (!ok && !commentAccessError) commentAccessError = { error, message };

        perPage.push({ page, blocks, comments, blocksProbed });
    }

    const allBlocks = perPage.flatMap((p) => p.blocks.map((b) => ({ block: b, page: p.page })));
    const allComments = perPage.flatMap((p) => p.comments.map((c) => ({ comment: c, page: p.page })));
    const allProperties = pages.results.flatMap((page) => pageProperties(page).map((property) => ({ property, page })));

    return {
        pages: pages.results,
        pagesTruncated: pages.truncated || pages.results.length >= config.maxPages,
        dataSources: dataSources.results,
        dataSourcesOk: dataSources.ok,
        searchError: pages.ok ? null : { error: pages.error, message: pages.message },
        commentAccessError,
        perPage,
        allBlocks,
        allComments,
        allProperties,
        cost: {
            pages: pages.results.length,
            blocks: allBlocks.length,
            properties: allProperties.length,
            comments: allComments.length,
            searchRequests: pages.pages + dataSources.pages,
            blockRequests,
            commentRequests,
            totalRequests: pages.pages + dataSources.pages + blockRequests + commentRequests,
            wallMs: Date.now() - startedAt,
            deepComments: config.deepComments,
            depthTruncatedPages: depthTruncated,
            maxPages: config.maxPages,
            maxBlockDepth: config.maxBlockDepth,
        },
    };
}

/** Extrapolates a measured sweep to a whole workspace, which is the real operational question. */
export function projectCost(cost, workspacePages) {
    if (!cost.pages || !workspacePages) return null;
    const perPage = cost.totalRequests / cost.pages;
    const requests = Math.round(perPage * workspacePages);
    return {
        requestsPerPage: Number(perPage.toFixed(1)),
        workspacePages,
        projectedRequests: requests,
        // Notion documents ~3 requests/second per connection.
        projectedSeconds: Math.round(requests / 3),
    };
}
