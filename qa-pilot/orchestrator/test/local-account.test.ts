import { describe, it, expect } from "vitest";
import { memoryStore } from "../src/store/memory.js";
import { ensureLocalUser, LOCAL_ACCOUNT_EMAIL } from "../src/auth/local-account.js";
import { verifyPassword } from "../src/auth/password.js";

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
});
