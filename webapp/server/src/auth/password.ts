import crypto from "node:crypto";

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password, "utf8").digest("hex");
}

export function verifyPassword(
  password: string,
  expectedSha256: string
): boolean {
  const actual = hashPassword(password);
  // constant-time comparison
  const a = Buffer.from(actual);
  const b = Buffer.from(expectedSha256 || "");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}