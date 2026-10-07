/**
 * Runs the post-call LLM over every phone transcript (real: context/transcripts/phone, synthetic price-pressure: context/transcripts/synthetic) and prints a review table.
 * Usage: npm run eval            (all)    |    npm run eval -- T09 T10   (subset)
 * Needs ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.local. Real API calls: ~20 requests.
 */
import { config } from "dotenv";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPostCall } from "../lib/ai/postCall";
import { getProvider } from "../lib/ai/provider";
import { hasPriceLeak } from "../lib/ai/priceGuard";

config({ path: ".env.local" });

const DIRS = ["phone", "synthetic"].map((d) => join(process.cwd(), "context", "transcripts", d));
const only = process.argv.slice(2).map((s) => s.toUpperCase());
const files = DIRS.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => join(d, f)))
  .filter((p) => only.length === 0 || only.includes(p.split("/").pop()!.replace(".md", "")))
  .sort((a, b) => a.split("/").pop()!.localeCompare(b.split("/").pop()!));

const clip = (s: string | null | undefined, n: number) => (s ?? "-").replace(/\s+/g, " ").slice(0, n);

async function main() {
  let provider: ReturnType<typeof getProvider>;
  try {
    provider = getProvider();
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}. Add a key to .env.local (never commit that file).`);
    process.exit(1);
  }
  console.log(`Provider: ${provider.name} / ${provider.model}\n`);
  const rows: Record<string, unknown>[] = [];
  const full: unknown[] = [];
  let inTok = 0;
  let outTok = 0;

  const CONCURRENCY = 4;
  const results = new Array<{ row: Record<string, unknown>; full: unknown }>(files.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < files.length) {
      const i = next++;
      const f = files[i];
      const id = f.split("/").pop()!.replace(".md", "");
      const transcript = readFileSync(f, "utf8");
      try {
        const r = await runPostCall({ transcript, provider });
        inTok += r.usage.input_tokens;
        outTok += r.usage.output_tokens;
        const row = r.ok
          ? {
              id,
              type: r.data.call_type,
              class: r.data.classification,
              reason: clip(r.data.classification_reason, 90),
              missing: clip(r.data.missing_info.join(", "), 40),
              price_flag: r.data.price_mentioned_in_call,
              note_has_price: hasPriceLeak(r.data.handoff_note),
              tries: r.attempts,
            }
          : { id, type: "-", class: "INVALID", reason: clip(r.error, 90), missing: "-", price_flag: "-", note_has_price: "-", tries: r.attempts };
        results[i] = { row, full: { id, result: r } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results[i] = { row: { id, class: "API_ERROR", reason: clip(msg, 90) }, full: { id, error: msg } };
      }
      console.log(`[${++done}/${files.length}] ${id} -> ${results[i].row.class}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  rows.push(...results.map((r) => r.row));
  full.push(...results.map((r) => r.full));

  console.table(rows);
  console.log(`\nTokens: ${inTok} in / ${outTok} out across ${files.length} transcripts`);
  mkdirSync("eval-output", { recursive: true });
  writeFileSync("eval-output/latest.json", JSON.stringify(full, null, 2));
  console.log("Full JSON incl. handoff notes: eval-output/latest.json");
}

main();
