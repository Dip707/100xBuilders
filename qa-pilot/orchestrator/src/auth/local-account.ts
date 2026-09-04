import type { Store, User } from "../store/types.js";
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
  return store.createUser(LOCAL_ACCOUNT_EMAIL, UNUSABLE_PASSWORD_HASH);
}
