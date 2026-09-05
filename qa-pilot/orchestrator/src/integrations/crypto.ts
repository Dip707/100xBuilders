import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Tracker API keys are sealed before they reach the store and opened only inside the
 * handler that needs them. AES-256-GCM with a key derived from QA_PILOT_SECRET: the
 * ciphertext is useless on its own, and a tampered blob fails the tag check rather than
 * decrypting to garbage.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const MISSING_SECRET = "QA_PILOT_SECRET is not set. Put a long random string in qa-pilot/.env; tracker API keys are encrypted with it";

function keyFrom(secret: string | undefined): Buffer {
  if (!secret) throw new Error(MISSING_SECRET);
  return createHash("sha256").update(secret).digest();
}

/** Encrypts any JSON-serialisable value. Each call uses a fresh IV, so equal inputs never produce equal output. */
export function seal(value: unknown, secret: string | undefined = process.env.QA_PILOT_SECRET): string {
  const key = keyFrom(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** The inverse of `seal`. Throws on a wrong key, a tampered blob or an unknown format. */
export function open<T = unknown>(sealed: string, secret: string | undefined = process.env.QA_PILOT_SECRET): T {
  const key = keyFrom(secret);
  const [version, payload] = sealed.split(".");
  if (version !== VERSION || !payload) throw new Error("unrecognised sealed value");
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
}
