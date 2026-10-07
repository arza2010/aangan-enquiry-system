/**
 * Pretend to be Vaani: POST a real transcript to our webhook in Vaani's `call_postprocessing` format.
 * Lets you demo the whole app (AI -> routing -> Telegram -> dashboard) without a phone number or a live call.
 *
 *   npm run webhook:replay -- T01                         # to APP_BASE_URL (default http://localhost:3000)
 *   npm run webhook:replay -- T01 T10 S01 --phone +919812345678 --url https://your-app.vercel.app
 * Needs the app running and VAANI_WEBHOOK_SECRET in .env.local. Each run uses a fresh call id, so repeats create new calls.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const base = flag("url", process.env.APP_BASE_URL ?? "http://localhost:3000");
const phone = flag("phone", "+919800000001");
const skip = new Set([flag("url", ""), flag("phone", "")]);
const ids = argv.filter((a) => !a.startsWith("--") && !skip.has(a)).map((a) => a.toUpperCase());
const secret = process.env.VAANI_WEBHOOK_SECRET;
if (!secret || ids.length === 0) {
  console.error("Usage: npm run webhook:replay -- T01 [T10 ...] [--phone +91...] [--url https://...]   (needs VAANI_WEBHOOK_SECRET)");
  process.exit(1);
}

function transcript(id: string): string {
  for (const dir of ["phone", "synthetic"]) {
    const d = join(process.cwd(), "context", "transcripts", dir);
    if (readdirSync(d).includes(`${id}.md`)) {
      const lines = readFileSync(join(d, `${id}.md`), "utf8").split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
      let t = 12 * 3600;
      const stamp = () => { t += 7; return `[${new Date(t * 1000).toISOString().slice(11, 19)}]`; };
      return lines
        .map((l) => l.replace(/^(Front Desk|Agent):/, "AGENT:").replace(/^Caller:/, "USER:"))
        .filter((l) => /^(AGENT|USER):/.test(l))
        .map((l) => `${stamp()} ${l}`)
        .join("\n\n");
    }
  }
  throw new Error(`No transcript ${id}`);
}

(async () => {
  for (const [i, id] of ids.entries()) {
    const callId = `replay-${id}-${Date.now()}`;
    const payload = {
      event: "call_postprocessing", call_id: callId, timestamp: new Date().toISOString(),
      data: { room_name: callId, call_id: callId, call_duration: 180_000, end_reason: "Call ended", summary: "replayed test call", entities: {}, dispositions: {}, from_number: phone.replace(/\d$/, String((i + 1) % 10)), transcript: transcript(id) },
    };
    const r = await fetch(`${base}/api/webhooks/vaani?token=${encodeURIComponent(secret)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    console.log(`${id}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  }
})().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
