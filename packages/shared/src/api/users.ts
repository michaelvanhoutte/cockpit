import { z } from 'zod';

/**
 * Who a user is, as far as anything outside the register is concerned: an id
 * to sign in with and a name to show.
 *
 * **Nothing else about a user crosses this boundary**, and that is the whole
 * shape of the type rather than a filter applied somewhere. The list of people
 * to choose from is served to anyone who can reach the logon page - it is the
 * one read that has to be, since it is what you look at before you are anybody
 * - so which account a user owns and what role they hold stay in the register,
 * where only the gate reads them.
 */
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type User = z.infer<typeof userSchema>;

/** The people who use this Cockpit, for the logon page to list. */
export const userListSchema = z.object({ users: z.array(userSchema) });
export type UserList = z.infer<typeof userListSchema>;

/** Signing in: you say which of them you are, and nothing else. */
export const signInSchema = z.object({ userId: z.string().min(1) });
export type SignIn = z.infer<typeof signInSchema>;

/** Who Cockpit currently believes you are. */
export const signedInSchema = z.object({ user: userSchema });
export type SignedIn = z.infer<typeof signedInSchema>;
