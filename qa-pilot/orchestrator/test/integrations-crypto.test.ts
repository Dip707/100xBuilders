import { describe, it, expect } from "vitest";
import { seal, open } from "../src/integrations/crypto.js";

describe("integration crypto", () => {
  it("round-trips a config and never stores it in the clear", () => {
    const sealed = seal({ apiKey: "lin_api_secret", teamId: "t1" }, "passphrase");
    expect(sealed).not.toContain("lin_api_secret");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(open(sealed, "passphrase")).toEqual({ apiKey: "lin_api_secret", teamId: "t1" });
  });

  it("produces a different ciphertext each time and rejects the wrong key", () => {
    expect(seal({ a: 1 }, "k")).not.toBe(seal({ a: 1 }, "k"));
    expect(() => open(seal({ a: 1 }, "k"), "other")).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = seal({ a: 1 }, "k");
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A=") ? "B=" : "A=");
    expect(() => open(flipped, "k")).toThrow();
  });

  it("names QA_PILOT_SECRET when no secret is configured", () => {
    const prev = process.env.QA_PILOT_SECRET;
    delete process.env.QA_PILOT_SECRET;
    try {
      expect(() => seal({ a: 1 })).toThrow(/QA_PILOT_SECRET/);
      expect(() => open("v1.abc")).toThrow(/QA_PILOT_SECRET/);
    } finally {
      if (prev !== undefined) process.env.QA_PILOT_SECRET = prev;
    }
  });
});
