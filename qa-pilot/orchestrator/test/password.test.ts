import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, UNUSABLE_PASSWORD_HASH } from "../src/auth/password.js";

describe("password", () => {
  it("round trips a correct password", async () => {
    const stored = await hashPassword("demo1234");
    expect(await verifyPassword("demo1234", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("demo1234");
    expect(await verifyPassword("demo12345", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("embeds the parameters and a unique salt, and never the plaintext", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).toMatch(/^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("same-password");
  });

  it("returns false rather than throwing for an unparseable hash", async () => {
    for (const bad of [UNUSABLE_PASSWORD_HASH, "", "nonsense", "scrypt$bad$x$y", "bcrypt$1$2$3"]) {
      expect(await verifyPassword("anything", bad), bad).toBe(false);
    }
  });

  it("returns false rather than throwing for a hash whose parameters pass the shape regex but are invalid at runtime", async () => {
    const salt = Buffer.alloc(16, 1).toString("base64");
    const key = Buffer.alloc(64, 2).toString("base64");

    // N=20000 is all digits, so it passes the parse() regex, but scrypt requires N to be a
    // power of two and rejects this one at the crypto layer.
    const nNotPowerOfTwo = `scrypt$N=20000,r=8,p=1$${salt}$${key}`;
    await expect(verifyPassword("anything", nNotPowerOfTwo)).resolves.toBe(false);

    // N=1048576 is a valid power of two, but at r=8 it needs ~1GiB of memory, which exceeds
    // Node's default scrypt maxmem (32MiB) and makes the derivation reject.
    const nExceedsMaxmem = `scrypt$N=1048576,r=8,p=1$${salt}$${key}`;
    await expect(verifyPassword("anything", nExceedsMaxmem)).resolves.toBe(false);
  });
});
