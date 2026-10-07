/**
 * End-to-end SIMULATION with fake designers. Real: transcripts, the AI, routing, alert timing, Telegram messages,
 * live Accept/Reassign buttons. Fake: the database (in memory, nothing persists), the designers, the phone calls, SMS.
 *
 *   npm run simulate                       default scenario (T01 T05 T10 T09 S01)
 *   npm run simulate -- T01 T13            chosen transcripts (see context/transcripts/phone and /synthetic)
 *   npm run simulate -- --speed 120        time runs 120x (a 10-min reminder fires after 5 real seconds)
 *   npm run simulate -- --minutes 6        how long to keep running after the last call (real minutes)
 *   npm run simulate -- --at 2026-09-09T22:47:00+05:30    pretend the calls arrive at night (quiet hours demo)
 *   npm run simulate -- --no-book          skip the simulated mid-call consult booking
 *
 * Everything lands in the chats from .env.local, each labelled "🧪 SIMULATION → who it would go to".
 * All simulated designers share ONE real chat (SIM_CHAT_ID, default TELEGRAM_NIKHIL_CHAT_ID) so you can tap their buttons.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, SETTINGS } from "../tests/helpers/fakeDb";
import { telegramClient, esc } from "../lib/telegram";
import { handleCallbackQuery } from "../lib/telegram-callbacks";
import { ingestCall } from "../lib/pipeline/ingest";
import { processCall } from "../lib/pipeline/process";
import { processDue } from "../lib/notify/dispatch";
import { getProvider } from "../lib/ai/provider";
import { fmtTime } from "../lib/time";
import { mockProvider } from "../lib/booking/mock";
import { offerSlots } from "../lib/booking/service";
import { toE164 } from "../lib/phone";
import type { Deps } from "../lib/deps";

// ── args ──
const argv = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const speed = Number(flag("speed", "60"));
const runMinutes = Number(flag("minutes", "4"));
const startAt = new Date(flag("at", "2026-09-16T12:19:00+05:30")); // a Wednesday, working hours
const flagValues = new Set(["--speed", "--minutes", "--at"].flatMap((f) => (argv.includes(f) ? [argv[argv.indexOf(f) + 1]] : [])));
const picked = argv.filter((a) => !a.startsWith("--") && !flagValues.has(a)).map((a) => a.toUpperCase());
const ids = picked.length ? picked : ["T01", "T05", "T10", "T09", "S01"];

// ── env checks ──
const token = process.env.TELEGRAM_BOT_TOKEN;
const frontDesk = process.env.TELEGRAM_FRONTDESK_CHAT_ID;
const simChat = (process.env.SIM_CHAT_ID ?? process.env.TELEGRAM_NIKHIL_CHAT_ID) as string;
if (!token || !frontDesk || !simChat) {
  console.error("Needs TELEGRAM_BOT_TOKEN, TELEGRAM_FRONTDESK_CHAT_ID and TELEGRAM_NIKHIL_CHAT_ID (or SIM_CHAT_ID) in .env.local");
  process.exit(1);
}
const provider = getProvider(); // throws a clear message if no LLM key

// ── virtual clock ──
// Frozen while a call is being analysed: the AI takes real seconds, which x60 would turn into simulated hours.
const t0 = Date.now();
let pausedMs = 0;
let pausedAt: number | null = null;
const now = () => new Date(startAt.getTime() + ((pausedAt ?? Date.now()) - t0 - pausedMs) * speed);
const pauseClock = () => { pausedAt ??= Date.now(); };
const resumeClock = () => { if (pausedAt !== null) { pausedMs += Date.now() - pausedAt; pausedAt = null; } };
const log = (m: string) => console.log(`[sim ${fmtTime(now())}] ${m}`);

// ── Telegram: real, but every message is labelled with its (simulated) recipient ──
const real = telegramClient();
const api = async (method: string, body: object = {}) =>
  (await (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { ok: boolean; result?: any; description?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any

// Stand-in for Cal.com: same interface, in memory. The simulated voice agent books into it mid-call, like Vaani's Cal.com integration.
const calendar = mockProvider({ now });
// Human front-desk transcripts that ended with "let's book it": the voice agent would have booked a consult on these.
const WOULD_BOOK = new Set(["T01", "T02", "T05", "T06", "T11", "T12", "T13", "T15", "T17", "T20", "S01", "S02", "S03"]);
const bookEnabled = !argv.includes("--no-book");

const deps: Deps = {
  now,
  crm: null,
  booking: calendar,
  telegram: {
    send: (chat, html, buttons, meta) => {
      log(`telegram → ${meta?.to ?? chat}: ${html.replace(/<[^>]+>/g, "").split("\n")[0].slice(0, 90)}`);
      return real.send(chat, `🧪 <i>SIMULATION → ${esc(meta?.to ?? "?")}</i>\n${html}`, buttons);
    },
    answerCallback: real.answerCallback,
    editMessage: real.editMessage,
  },
  // SMS to callers is shown in your Telegram instead of going to a phone.
  sms: {
    name: "simulation",
    send: async (to, text) => {
      log(`sms → ${to}: ${text.slice(0, 80)}`);
      await real.send(simChat, `🧪 <i>SIMULATION → Caller (SMS to ${esc(to)})</i>\n📱 ${esc(text)}`);
    },
  },
};

// ── in-memory database with fake designers ──
const simDesigner = (id: string, name: string, specialisation: string) => ({
  id, name: `${name} (sim)`, active: true, specialisation, areas_served: [], telegram_chat_id: simChat, night_alerts: false,
});
const { db, tables } = fakeDb({
  settings: SETTINGS.map((r) => (r.key === "digest_time" ? { ...r, value: "23:59" } : r)), // keep the daily digest out of the demo
  designers: [simDesigner("d1", "Anaya", "home"), simDesigner("d2", "Bhavin", "home"), simDesigner("d3", "Chitra", "office")],
  calls: [], leads: [], bookings: [],
});

function transcriptFor(id: string): string {
  for (const dir of ["phone", "synthetic"]) {
    const dirPath = join(process.cwd(), "context", "transcripts", dir);
    const f = readdirSync(dirPath).find((x) => x === `${id}.md`);
    if (f) return readFileSync(join(dirPath, f), "utf8").split("\n").slice(1).join("\n").trim(); // drop the "# T01 · ..." header
  }
  throw new Error(`No transcript ${id}. Use ids like T01 or S01.`);
}

// ── background loop: send due alerts, and listen for Accept/Reassign taps ──
let offset = 0;
let running = true;
async function tick() {
  while (running) {
    try {
      await processDue(db, deps);
      const r = await api("getUpdates", { offset, timeout: 1, allowed_updates: ["callback_query"] });
      for (const u of r.result ?? []) {
        offset = u.update_id + 1;
        if (u.callback_query) {
          log(`button tapped: ${u.callback_query.data}`);
          await handleCallbackQuery(db, deps, u.callback_query);
        }
      }
    } catch (e) {
      console.error("tick error:", e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const wh = await api("getWebhookInfo");
  if (wh.result?.url) {
    console.error(`A webhook is already set (${wh.result.url}), so button taps go there, not here. Remove it first:\n  curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`);
    process.exit(1);
  }
  const old = await api("getUpdates", { offset: -1 });
  if (old.result?.length) offset = old.result[old.result.length - 1].update_id + 1; // ignore taps from earlier runs

  console.log(`\nSIMULATION  ${ids.join(" ")}  | AI: ${provider.name}/${provider.model} | time x${speed} from ${fmtTime(startAt)} | runs ~${runMinutes} min after the last call`);
  console.log(`Front desk group, Nikhil and all 3 fake designers deliver to your real Telegram chats. Tap the buttons there.\n`);
  await real.send(simChat, `🧪 <b>Simulation starting</b>: ${ids.join(", ")} (time x${speed}). Alerts below are labelled with who they would go to. Tap Accept / Reassign to try the workflow.`);

  const loop = tick();
  for (const [i, id] of ids.entries()) {
    const phone = `+9199990000${String(i + 1).padStart(2, "0")}`;
    const started = now();
    log(`📞 call ${id} from ${phone}`);
    pauseClock();
    try {
      if (bookEnabled && WOULD_BOOK.has(id)) {
        const [slot] = await offerSlots(db, calendar, now());
        if (slot) {
          await calendar.book({ start: slot, name: `Caller ${id}`, phone: toE164(phone), callRef: `sim-${id}` });
          log(`   (the voice agent booked a consult for ${fmtTime(new Date(slot))} in the calendar during the call)`);
        }
      }
      const { callId } = await ingestCall(db, {
        channel: "phone", external_id: `sim-${id}`, caller_phone: phone, started_at: started.toISOString(),
        ended_at: started.toISOString(), duration_sec: 180, transcript: transcriptFor(id), language: null, raw: { simulated: true },
      });
      const r = await processCall(db, deps, callId);
      const lead = tables.leads.find((l) => l.id === r.leadId)!;
      const d = tables.designers.find((x) => x.id === lead.assigned_designer_id);
      log(`   ${id}: ${lead.classification ?? "no classification"} (${lead.call_type}) → ${d ? d.name : lead.status}${lead.review_reason ? ` · ${lead.review_reason}` : ""}`);
    } catch (e) {
      console.error(`   ${id} failed:`, e instanceof Error ? e.message : e);
    } finally {
      resumeClock();
    }
    await new Promise((r) => setTimeout(r, 4000)); // calls arrive a few seconds apart
  }

  log(`all calls processed; waiting ${runMinutes} min (real) so reminders, escalations and your button taps play out. Ctrl+C to stop.`);
  const stop = () => { running = false; };
  process.on("SIGINT", stop);
  setTimeout(stop, runMinutes * 60_000);
  await loop;

  console.log("\n── Summary ──");
  console.table(tables.leads.map((l) => ({
    call: String((tables.calls.find((c) => c.id === l.call_id)?.external_id as string) ?? "").replace("sim-", ""),
    class: l.classification, type: l.call_type, status: l.status,
    designer: (tables.designers.find((d) => d.id === l.assigned_designer_id)?.name as string) ?? "-",
    accepted: l.accepted_at ? "yes" : "no",
  })));
  const n = tables.notifications;
  console.log(`Notifications: ${n.filter((x) => x.sent_at).length} sent, ${n.filter((x) => x.cancelled_at).length} cancelled (e.g. reminders after Accept), ${n.filter((x) => !x.sent_at && !x.cancelled_at).length} still queued`);
  process.exit(0);
}
main();
