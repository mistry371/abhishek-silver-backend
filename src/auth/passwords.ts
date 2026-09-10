import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, OPTIONS, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Always do the work so response timing doesn't reveal whether an account exists.
  const [scheme, saltB64, keyB64] = (stored ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$").split("$");
  if (scheme !== "scrypt" || !saltB64) return false;
  const actual = await derive(password, Buffer.from(saltB64, "base64"));
  const expected = Buffer.from(keyB64 ?? "", "base64");
  return Boolean(stored) && expected.length === actual.length && timingSafeEqual(expected, actual);
}
