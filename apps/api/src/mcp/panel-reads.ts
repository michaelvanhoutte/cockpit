import { z } from 'zod';
import { panelList, panelRead } from '@cockpit/shared';
import { NotFoundInAccountError, openAccount } from '../accounts/index.js';
import type { Env } from '../env.js';
import { APPS_PATH, PANEL_READS_PATH, isAnAddressOfTheReadsOfPanels } from '../auth/mcp-paths.js';
import { noteRead } from './connected-apps.js';
import { grantHolder } from './grant.js';
import { grantIdOf, tokenRefused, type ProtectedContext } from './server.js';

/**
 * The two reads of Panels a connected app is given ("Read a Panel
 * from an app allowed only to read, and open Capture from its address", issue
 * 1445): the list of Panels to choose from, and one Panel's rows.
 *
 * | Address | Answers |
 * |---|---|
 * | `GET /apps/v1/panels` | every Workspace with its Dashboards and Panels (`panelList`) |
 * | `GET /apps/v1/panels/<id>?date=2026-10-23` | that Panel's rows, as Cockpit draws them, judged by `date` (`panelRead`) |
 *
 * **Reached only with a token made for `/apps`** (`oauth.ts`: the library refuses
 * any other before this runs), and asked again on every read who the grant acts
 * for (`grant.ts`), so Disconnect, a deleted person and a person whose access was
 * taken away all end the next read.
 *
 * **Counted with the grant's captures**, the same 60 a minute and refused ones
 * included: the two reads of a phone with several widgets are a few a half hour,
 * and this is a ceiling on a runaway loop, as it is for capture.
 *
 * **The date is the phone's and is required**: *due today* and *this week* are
 * the week of whoever is looking, so defaulting to the day this Worker works out
 * - which is UTC - would be wrong for a phone an hour either side of midnight.
 *
 * **A Panel that cannot be read is not found, and nothing else is said**:
 * deleted, never held, another person's (whose store this one cannot see) and
 * one of text all answer the same, so the answer says nothing about which.
 */

const SOMETHING_BROKE = 'Something went wrong in Cockpit. Try again in a moment.';

/** `2026-10-23`, and a real day in the calendar: `2026-02-30` is not one. */
const dateSchema = z.iso.date();

export async function answerPanelRead(request: Request, env: Env, ctx: ProtectedContext): Promise<Response> {
  if (request.method !== 'GET') return said(405, { error: 'reads are asked for with GET' }, { allow: 'GET' });
  // Anything else under `/apps` is no read there is: `v2` is not held until it exists.
  if (!isAnAddressOfTheReadsOfPanels(new URL(request.url).pathname)) return notFound();

  try {
    const holder = await grantHolder(env, ctx.props);
    if (!holder) return tokenRefused(env, APPS_PATH);
    const account = await openAccount(env, holder.accountName);
    const grantId = grantIdOf(ctx.auth?.token);
    const now = new Date().toISOString();
    if ((await account.appCaptureArrived(grantId, now)) === 'too-many') {
      return said(429, { error: 'Too many reads in the last minute. Wait a minute and try again.' }, { 'retry-after': '60' });
    }

    const url = new URL(request.url);
    const rest = url.pathname.slice(PANEL_READS_PATH.length);
    let answer: Response;
    if (rest === '' || rest === '/') {
      answer = said(200, panelList(await account.panelCatalogue()));
    } else {
      const panelId = idIn(rest.slice(1));
      const date = dateSchema.safeParse(url.searchParams.get('date') ?? '');
      if (!date.success) {
        answer = said(400, { error: 'date must be a day, as 2026-10-23, on the phone it is read on' });
      } else if (panelId === null) {
        answer = notFound();
      } else {
        answer = await readOne(account, panelId, date.data);
      }
    }
    if (answer.ok) ctx.waitUntil(noteRead(env, grantId, now));
    return answer;
  } catch (error) {
    const { message, stack } = error instanceof Error ? error : { message: String(error), stack: undefined };
    console.error(JSON.stringify({ level: 'error', message, stack }));
    return said(500, { error: SOMETHING_BROKE });
  }
}

async function readOne(
  account: Awaited<ReturnType<typeof openAccount>>,
  panelId: string,
  date: string,
): Promise<Response> {
  try {
    const read = panelRead(await account.panelReadInputs(panelId), panelId, date);
    return read ? said(200, read) : notFound();
  } catch (error) {
    if (error instanceof NotFoundInAccountError) return notFound();
    throw error;
  }
}

/** The id the address names, or null for an address no Panel could have: an escape that is not one, or a further path. */
function idIn(segment: string): string | null {
  try {
    const id = decodeURIComponent(segment);
    return id === '' || id.includes('/') ? null : id;
  } catch {
    return null;
  }
}

function notFound(): Response {
  return said(404, { error: 'not found' });
}

function said(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}
