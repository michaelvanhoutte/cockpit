/**
 * The issues API, and nothing else: the alarm issues alarm.js decides about.
 * Like github.js it only fetches and sends; what to send is alarm.js's.
 *
 * Reads are not retried: a failed night is run again by hand. Writes are never
 * retried either, since a create that timed out may have landed, and asking
 * again is how one bar gets two issues.
 */

import { ALARM_LABEL } from './alarm.js';

const API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 10;
const LABEL_COLOR = 'd73a4a';
const LABEL_DESCRIPTION = 'Filed by the nightly Selection job when a test selection bar is crossed';

/** Thrown for any refused or failed call, with the status where there is one. */
export class IssuesError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'IssuesError';
    this.status = status;
  }
}

async function call({ method = 'GET', path, body, token, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cockpit-selection',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new IssuesError(`Could not reach GitHub for ${method} ${path}: ${error.message}`);
  }
  if (!res.ok) {
    const detail = await res.text().then((text) => text.slice(0, 300), () => '');
    throw new IssuesError(`GitHub answered ${res.status} for ${method} ${path}${detail ? `: ${detail}` : ''}`, { status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

/** Every page of a list endpoint, up to a cap that no repository of alarms reaches. */
async function pages(path, ctx) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await call({ ...ctx, path: `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}` });
    rows.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return rows;
}

/**
 * Every `selection-alarm` issue in every state (pull requests carry labels
 * too, and are left out), each with `comments: []` until a caller asks for them.
 *
 * @param {{ repo: string, token?: string, fetchImpl?: typeof fetch }} ctx
 */
export async function listAlarmIssues({ repo, ...ctx }) {
  const rows = await pages(`/repos/${repo}/issues?labels=${ALARM_LABEL}&state=all`, ctx);
  return rows.filter((row) => !row.pull_request).map((row) => ({ number: row.number, state: row.state, title: row.title, body: row.body ?? '', comments: [] }));
}

/** An issue's comments, as their bodies. */
export async function listComments({ repo, number, ...ctx }) {
  const rows = await pages(`/repos/${repo}/issues/${number}/comments`, ctx);
  return rows.map((row) => row.body ?? '');
}

/** The label, created if the repository has none; another run creating it first is not a failure. */
export async function ensureLabel({ repo, ...ctx }) {
  try {
    await call({ ...ctx, path: `/repos/${repo}/labels/${ALARM_LABEL}` });
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await call({ ...ctx, method: 'POST', path: `/repos/${repo}/labels`, body: { name: ALARM_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION } });
    } catch (created) {
      if (created.status !== 422) throw created;
    }
  }
}

/** @returns {Promise<number>} the new issue's number */
export async function createIssue({ repo, title, body, ...ctx }) {
  const issue = await call({ ...ctx, method: 'POST', path: `/repos/${repo}/issues`, body: { title, body, labels: [ALARM_LABEL] } });
  return issue.number;
}

export async function editIssue({ repo, number, title, body, ...ctx }) {
  await call({ ...ctx, method: 'PATCH', path: `/repos/${repo}/issues/${number}`, body: { title, body } });
}

export async function addComment({ repo, number, body, ...ctx }) {
  await call({ ...ctx, method: 'POST', path: `/repos/${repo}/issues/${number}/comments`, body: { body } });
}
