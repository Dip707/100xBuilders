import { describe, it, expect } from "vitest";
import { memoryStore } from "../src/store/memory.js";
import { ensureLocalUser, LOCAL_ACCOUNT_EMAIL } from "../src/auth/local-account.js";
import { verifyPassword } from "../src/auth/password.js";
import { EmailTakenError, type Store, type User } from "../src/store/types.js";

describe("ensureLocalUser", () => {
  it("creates the account once and returns the same one afterwards", async () => {
    const store = memoryStore();
    const first = await ensureLocalUser(store);
    const second = await ensureLocalUser(store);
    expect(first.id).toBe(second.id);
    expect(first.email).toBe(LOCAL_ACCOUNT_EMAIL);
  });

  it("stores a hash that no password can ever satisfy", async () => {
    const store = memoryStore();
    await ensureLocalUser(store);
    const found = await store.findUserByEmail(LOCAL_ACCOUNT_EMAIL);
    for (const attempt of ["", "-", "password", "local@qa-pilot"]) {
      expect(await verifyPassword(attempt, found!.passwordHash), attempt).toBe(false);
    }
  });

  it("survives losing a create race to a concurrent CLI process", async () => {
    const store = memoryStore();
    let firstCall = true;
    // Simulate a second process winning the race: the underlying insert really
    // happens (so a lookup afterwards finds it), but the caller still sees the
    // duplicate-key error a loser would see.
    const racy: Store = {
      ...store,
      createUser: async (email: string, passwordHash: string): Promise<User> => {
        const created = await store.createUser(email, passwordHash);
        if (firstCall) {
          firstCall = false;
          throw new EmailTakenError(email);
        }
        return created;
      },
    };

    const user = await ensureLocalUser(racy);
    expect(user.email).toBe(LOCAL_ACCOUNT_EMAIL);
    const found = await store.findUserByEmail(LOCAL_ACCOUNT_EMAIL);
    expect(found!.id).toBe(user.id);
  });

  it("rejects rather than inventing an account when the store is genuinely broken", async () => {
    const store = memoryStore();
    const broken: Store = {
      ...store,
      createUser: async (email: string): Promise<User> => {
        throw new EmailTakenError(email);
      },
      findUserByEmail: async () => null,
    };

    await expect(ensureLocalUser(broken)).rejects.toBeInstanceOf(EmailTakenError);
  });
});
