import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (p: string | Buffer, s: Buffer, k: number, o: { N: number; r: number; p: number }) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * A hash that can never validate. Stored on the reserved CLI account so its runs can be
 * attributed without the account being loggable-into: verifyPassword cannot parse it and
 * therefore returns false for every input.
 */
export const UNUSABLE_PASSWORD_HASH = "-";

/** `scrypt$N=16384,r=8,p=1$<salt b64>$<key b64>`. Parameters travel with the hash so the cost can be raised later without invalidating existing accounts. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plain, salt, KEY_BYTES, PARAMS);
  return `scrypt$N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

let dummy: Promise<string> | undefined;

/**
 * A valid, parseable hash of a value nobody can guess. Verifying a submitted password
 * against it forces a real scrypt derivation, so a login attempt for an address that has
 * no account costs the same as one for an address that does. Without this, the identical
 * 401 body that /login returns in both cases is undone by a measurable timing difference,
 * because scrypt dominates the request.
 *
 * Deliberately NOT `UNUSABLE_PASSWORD_HASH`: that value fails to parse and returns false
 * before any derivation runs, which is exactly the cost asymmetry being closed here.
 */
export function dummyVerifyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString("hex"));
  return dummy;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  // parse() only checks the parameter string is shaped like digits; it cannot validate that
  // N is a power of two or that N/r/p stay under Node's scrypt maxmem. A stored hash that
  // fails those runtime constraints must still make verifyPassword resolve to false rather
  // than reject, so a corrupted or maliciously-crafted stored hash can never be turned into
  // an unhandled rejection by a caller that only awaits a boolean.
  let candidate: Buffer;
  try {
    candidate = await scryptAsync(plain, parsed.salt, parsed.key.length, parsed.params);
  } catch {
    return false;
  }
  // Lengths are equal by construction here, but timingSafeEqual throws on a mismatch,
  // so guard rather than let a malformed stored hash become an exception.
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}

function parse(stored: string): { params: { N: number; r: number; p: number }; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return null;
  const matched = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]);
  if (!matched) return null;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const key = Buffer.from(parts[3], "base64");
    if (salt.length === 0 || key.length === 0) return null;
    return { params: { N: Number(matched[1]), r: Number(matched[2]), p: Number(matched[3]) }, salt, key };
  } catch {
    return null;
  }
}
