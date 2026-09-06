import { z } from 'zod';

/**
 * Who a user is, as far as anything outside the register is concerned: an id
 * and a name to show.
 *
 * **Nothing else about a user crosses this boundary**, and that is the whole
 * shape of the type rather than a filter applied somewhere - which account
 * somebody owns, what role they hold and the Google account they sign in with
 * all stay in the register, where only the gate reads them.
 *
 * **It answers one question now, not two.** There was a second: the list of
 * everybody, which the logon page showed you to pick a name from. Signing in is
 * Google's answer since "Sign in with Google, and retire the list of names"
 * (issue 196), so the only thing anyone is told about a user is who they
 * themselves are signed in as.
 */
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type User = z.infer<typeof userSchema>;

/** Who Cockpit currently believes you are. */
export const signedInSchema = z.object({ user: userSchema });
export type SignedIn = z.infer<typeof signedInSchema>;
