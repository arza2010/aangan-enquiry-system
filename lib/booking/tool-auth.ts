import { timingSafeEqual } from "node:crypto";

/** Vaani calls our booking endpoints with a shared secret in `x-tool-secret` (or `Authorization: Bearer`). */
export function toolAuthorised(req: Request): boolean {
  const secret = process.env.VAANI_TOOL_SECRET;
  if (!secret) return false; // fail closed
  const given = req.headers.get("x-tool-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
