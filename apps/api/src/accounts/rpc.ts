import type { Rpc } from '@cloudflare/workers-types';
import type {
  CommandName,
  CommandPayload,
  CommandResult,
  ServerEvent,
  Workspace,
} from '@cockpit/shared';
import type { AccountSnapshot, Answer } from './answer.js';

/**
 * What one account's store answers to, as the Worker sees it across the
 * binding.
 *
 * Written out here rather than inferred from the class, for one reason that is
 * not about taste: `store.ts` imports `DurableObject` from `cloudflare:workers`,
 * a module that only exists inside the Workers runtime's own type definitions.
 * `apps/web` compiles this package's source to infer the API contract, and it
 * cannot resolve that module - so the type the binding is declared with has to
 * be reachable without it. `AccountStore implements AccountStoreRpc` is what
 * keeps the two honest.
 *
 * Every method takes the account's name. Redundant, since the object *is* the
 * account - and that is the point: it is what every query filters on, so a
 * request that reached the wrong store matches no row instead of answering with
 * somebody else's data.
 *
 * The return types allow the value or a promise for it, because the object's
 * own SQLite is synchronous while the caller always awaits across the binding.
 */
export interface AccountStoreRpc extends Rpc.DurableObjectBranded {
  workspaces(accountName: string): Awaitable<Answer<Workspace[]>>;
  snapshot(accountName: string, workspaceId: string): Awaitable<Answer<AccountSnapshot>>;
  changesSince(
    accountName: string,
    since: string,
  ): Awaitable<Answer<{ events: ServerEvent[]; cursor: string }>>;
  applyChange<N extends CommandName>(
    accountName: string,
    name: N,
    payload: CommandPayload<N>,
  ): Awaitable<Answer<CommandResult>>;
}

type Awaitable<T> = T | Promise<T>;
