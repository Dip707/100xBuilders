import { EmailTakenError, type Store, type User } from "../store/types.js";
import { UNUSABLE_PASSWORD_HASH } from "./password.js";

/**
 * Runs started from the CLI still belong to somebody, so they are attributed to this
 * reserved account. It carries a hash that verifyPassword cannot parse, so it always
 * returns false and nobody can log in as it through the API. Its address has no dot in
 * the host on purpose: the signup route requires a valid email, so this account cannot
 * be created or claimed from outside.
 */
export const LOCAL_ACCOUNT_EMAIL = "local@qa-pilot";

export async function ensureLocalUser(store: Store): Promise<User> {
  const existing = await store.findUserByEmail(LOCAL_ACCOUNT_EMAIL);
  if (existing) return { id: existing.id, email: existing.email, createdAt: existing.createdAt };
  try {
    return await store.createUser(LOCAL_ACCOUNT_EMAIL, UNUSABLE_PASSWORD_HASH);
  } catch (err) {
    // Two CLI processes can both find no reserved account on the very first run and
    // both try to create it. The loser lands here: re-read the account the winner
    // just created rather than crashing the run. If it still is not there, the store
    // itself is broken, so rethrow instead of inventing a fallback account.
    if (!(err instanceof EmailTakenError)) throw err;
    const winner = await store.findUserByEmail(LOCAL_ACCOUNT_EMAIL);
    if (!winner) throw err;
    return { id: winner.id, email: winner.email, createdAt: winner.createdAt };
  }
}
