import { and, eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { createDb } from '../db/client.js';
import { emailAddresses } from '../db/schema.js';

/**
 * Which account an Email to Cockpit address points at ("Get an Email to
 * Cockpit address, and receive mail at it", issue 1466): the register's half,
 * `email_addresses` (`db/schema.ts`). **A hint, never the authority**: the
 * account's own store holds the address, and a row it does not confirm is an
 * address nobody holds.
 *
 * **Written before the store, forgotten after it.** *Get an address* and *Make
 * a new address…* add the new row first and then let the store hold it, so an
 * address the store holds always has its row; the row of the address let go is
 * forgotten once the store has let it go. Stopped between the two, a row is
 * left that the store does not confirm, and its mail is rejected and the row
 * swept (`forgetUnconfirmed`) - never a store holding an address nobody can
 * reach.
 */

/** A row as it was read, carrying what makes it the row that was read. */
export interface AddressAsRead {
  readonly accountName: string;
  readonly heldAt: string;
}

/**
 * Adds the row for a new random part, or finds it already this account's - a
 * *Get an address* sent twice. `taken` where another account holds it, which
 * nothing but a collision of two random parts reaches.
 */
export async function holdAddress(
  env: Env,
  localPart: string,
  accountName: string,
  heldAt: string,
): Promise<'held' | 'taken'> {
  const db = createDb(env.DB);
  await db
    .insert(emailAddresses)
    .values({ localPart, accountId: accountName, heldAt })
    .onConflictDoNothing({ target: emailAddresses.localPart })
    .run();
  const row = await whoseAddress(env, localPart);
  return row?.accountName === accountName ? 'held' : 'taken';
}

/** The account a random part points at, or null where no row names it. */
export async function whoseAddress(env: Env, localPart: string): Promise<AddressAsRead | null> {
  const row = await createDb(env.DB)
    .select({ accountName: emailAddresses.accountId, heldAt: emailAddresses.heldAt })
    .from(emailAddresses)
    .where(eq(emailAddresses.localPart, localPart))
    .get();
  return row ?? null;
}

/** Forgets the row of an address this account let go - only this account's, so nothing another holds is touched. */
export async function forgetAddress(env: Env, localPart: string, accountName: string): Promise<void> {
  await createDb(env.DB)
    .delete(emailAddresses)
    .where(and(eq(emailAddresses.localPart, localPart), eq(emailAddresses.accountId, accountName)))
    .run();
}

/**
 * `forgetAddress` after the store has let it go, which never fails the change
 * it follows: the store has committed by now, and a row left behind is one it
 * does not confirm, so its mail is rejected and the row swept when mail next
 * arrives. Logged, so a row left is seen.
 */
export async function forgetAddressAfterLettingGo(env: Env, localPart: string, accountName: string): Promise<void> {
  try {
    await forgetAddress(env, localPart, accountName);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message:
          'an Email to Cockpit address was let go, but its register row was not forgotten - its mail is rejected, and the row is swept when mail next arrives',
        account: accountName,
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * How long a row may wait for its store before a sweep takes it: a *Get an
 * address* writes its row and then its store, so a row younger than this may be
 * one whose store write is still on its way.
 */
export const UNCONFIRMED_SWEPT_AFTER_MS = 60_000;

/**
 * Sweeps a row the account's store does not confirm, answering whether a row
 * was deleted. **Never one younger than `UNCONFIRMED_SWEPT_AFTER_MS`**: its mail is
 * rejected all the same, but the row stays, so a *Get an address* whose store
 * write lands a moment later still has it. **Only the row that was read**, as
 * `forgetConnection` (`connectors/directory.ts`) does, which is what `heldAt`
 * in the condition is for.
 */
export async function forgetUnconfirmed(
  env: Env,
  localPart: string,
  read: AddressAsRead,
  now: Date,
): Promise<boolean> {
  if (now.getTime() - Date.parse(read.heldAt) < UNCONFIRMED_SWEPT_AFTER_MS) return false;
  const swept = await createDb(env.DB)
    .delete(emailAddresses)
    .where(
      and(
        eq(emailAddresses.localPart, localPart),
        eq(emailAddresses.accountId, read.accountName),
        eq(emailAddresses.heldAt, read.heldAt),
      ),
    )
    .run();
  return (swept.meta.changes ?? 0) > 0;
}
