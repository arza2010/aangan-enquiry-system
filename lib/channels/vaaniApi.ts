import { VaaniCallMetaSchema, type VaaniCallMeta } from "./vaani";

const BASE = "https://api.vaanivoice.ai";

type Fetch = typeof fetch;

async function page(apiKey: string, n: number, size: number, f: Fetch) {
  const res = await f(`${BASE}/api/call-history?page=${n}&page_size=${size}`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`Vaani call-history ${res.status}`);
  return (await res.json()) as { data?: unknown[]; pagination?: { total_pages?: number } };
}

/**
 * Look up one call's metadata (caller number, start time, billed credits).
 * The API has no filter by call id and its sort order is undocumented, so check the first page
 * and the last page (a just-finished call is on one of the two). Retries because post-processing
 * can land a moment before the history row does. Returns null instead of throwing: the pipeline
 * then stores the call with an unknown number and flags it for review.
 */
export async function fetchVaaniCallMeta(
  callId: string,
  apiKey: string | undefined,
  opts: { f?: Fetch; retries?: number; delayMs?: number } = {},
): Promise<VaaniCallMeta | null> {
  if (!apiKey) return null;
  const f = opts.f ?? fetch;
  const retries = opts.retries ?? 3;
  for (let i = 0; i < retries; i++) {
    try {
      const first = await page(apiKey, 1, 200, f);
      const find = (rows: unknown[] = []) =>
        rows.map((r) => VaaniCallMetaSchema.safeParse(r)).find((r) => r.success && r.data.call_id === callId);
      const hit = find(first.data);
      if (hit?.success) return hit.data;
      const last = first.pagination?.total_pages ?? 1;
      if (last > 1) {
        const tail = await page(apiKey, last, 200, f);
        const t = find(tail.data);
        if (t?.success) return t.data;
      }
    } catch (e) {
      console.error("vaani call-history lookup failed", e instanceof Error ? e.message : e);
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, opts.delayMs ?? 2000));
  }
  return null;
}
