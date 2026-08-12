// Thin Notion REST client. Records every call so the report can show exactly what was
// sent and what came back — and, more importantly for this POC, *how many* calls each
// signal cost. Notion has no content search, so mentions and comments have to be
// crawled, and the request count is the finding.
import { config } from './config.js';

const BASE = 'https://api.notion.com/v1';
const INTERESTING_HEADERS = ['retry-after', 'x-request-id'];

export const callLog = [];

export function resetCallLog() {
    callLog.length = 0;
}

export function callStats() {
    return {
        requests: callLog.length,
        failed: callLog.filter((c) => !c.ok).length,
        rateLimited: callLog.filter((c) => c.status === 429).length,
        totalMs: callLog.reduce((sum, c) => sum + c.ms, 0),
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Notion documents an average of ~3 requests/second per connection. Every call goes
// through one serialized queue, so a deep crawl cannot outrun the limit on its own.
let queue = Promise.resolve();
let lastCallAt = 0;

function schedule(task) {
    const run = queue.then(async () => {
        const wait = config.requestIntervalMs - (Date.now() - lastCallAt);
        if (wait > 0) await sleep(wait);
        lastCallAt = Date.now();
        return task();
    });
    // Keep the chain alive whatever happens to this task, otherwise one rejection
    // stalls every later call.
    queue = run.then(() => undefined, () => undefined);
    return run;
}

export function notionCall(method, path, options = {}) {
    return schedule(() => rawCall(method, path, options));
}

async function rawCall(method, path, { body, query, retryOn429 = true, note = null } = {}) {
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(query || {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const startedAt = Date.now();
    let res;
    let json;
    let transportError = null;

    try {
        res = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${config.token}`,
                'Notion-Version': config.version,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            json = { object: 'error', code: 'non_json_response', message: text.slice(0, 2000) };
        }
    } catch (err) {
        transportError = err.message;
        json = { object: 'error', code: 'transport_error', message: err.message };
    }

    const ok = Boolean(res?.ok) && json?.object !== 'error';
    const headers = {};
    if (res) {
        for (const name of INTERESTING_HEADERS) {
            const value = res.headers.get(name);
            if (value !== null) headers[name] = value;
        }
    }

    const entry = {
        method,
        path,
        query: query ?? null,
        request: body ?? null,
        status: res ? res.status : 0,
        ok,
        error: ok ? null : (json?.code ?? transportError ?? 'unknown_error'),
        message: ok ? null : (json?.message ?? null),
        headers,
        ms: Date.now() - startedAt,
        // Set when a call is *expected* to fail, so a deliberate capability probe does not
        // read as a broken run in the request log.
        note,
    };
    callLog.push(entry);

    // One polite retry, so a burst is not reported as a capability failure.
    if (!ok && res?.status === 429 && retryOn429) {
        const retryAfter = Number(res.headers.get('retry-after') || 1);
        await sleep(Math.min(retryAfter, 30) * 1000);
        return rawCall(method, path, { body, query, retryOn429: false, note });
    }

    return { json, call: entry };
}

// --- Endpoints ------------------------------------------------------------------
// Only the ones this POC needs. Note what is absent from the whole API and therefore
// cannot appear here: no notifications endpoint, no inbox endpoint, no activity feed,
// no workspace-wide comment listing, and no content search.

/** The bot behind the token — not you. See config.js on why that distinction matters. */
export const retrieveSelf = () => notionCall('GET', '/users/me');

/** Needs the "read user information including email addresses" capability. */
export const listUsers = (startCursor) =>
    notionCall('GET', '/users', { query: { page_size: 100, start_cursor: startCursor } });

/** POST /v1/search — matches page and data source *titles* only. Never body content. */
export const search = (body) => notionCall('POST', '/search', { body });

export const retrieveDataSource = (id) => notionCall('GET', `/data_sources/${id}`);

export const queryDataSource = (id, body) => notionCall('POST', `/data_sources/${id}/query`, { body });

export const retrievePage = (id) => notionCall('GET', `/pages/${id}`);

export const blockChildren = (id, startCursor) =>
    notionCall('GET', `/blocks/${id}/children`, { query: { page_size: 100, start_cursor: startCursor } });

/**
 * GET /v1/comments — "Retrieves a list of un-resolved Comment objects from a page or
 * block." Two consequences the POC exists to measure: it takes one block at a time, so
 * there is no way to ask "all comments involving me", and resolved comments simply are
 * not returned, which is the only handled-signal Notion offers for a comment.
 */
export const listComments = (blockId, startCursor, note) =>
    notionCall('GET', '/comments', { query: { block_id: blockId, page_size: 100, start_cursor: startCursor }, note });

/** Walks a cursor-paginated endpoint. `fetchPage(cursor)` must return `{json, call}`. */
export async function paginate(fetchPage, { max = Infinity } = {}) {
    const results = [];
    let cursor;
    let lastCall = null;
    let pages = 0;

    do {
        const { json, call } = await fetchPage(cursor);
        lastCall = call;
        pages += 1;
        if (!call.ok) return { results, pages, ok: false, call, error: call.error, message: call.message };
        results.push(...(json.results || []));
        cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor && results.length < max);

    return { results: results.slice(0, max), pages, ok: true, call: lastCall, error: null, truncated: Boolean(cursor) };
}

/** "https://www.notion.so/Some-Page-24f1f3...?pvs=4" -> "24f1f3..." (dashed uuid) */
export function urlToId(url) {
    const m = /([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url || '');
    if (!m) return null;
    const raw = (m[0] || '').replace(/-/g, '').toLowerCase();
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export const sameId = (a, b) => Boolean(a && b) && String(a).replace(/-/g, '') === String(b).replace(/-/g, '');
