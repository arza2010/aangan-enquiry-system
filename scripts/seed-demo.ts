/**
 * Fill YOUR Supabase with ~a month of realistic history so the dashboard and review queue have something to show.
 * Runs the real pipeline (real AI classification, real routing) on the transcripts at back-dated times, with Telegram,
 * SMS and Cal.com SILENCED, so no real chat gets a message. Afterwards every still-pending alert is cancelled so the
 * live cron can never send alerts for demo leads.
 *
 *   npm run seed:demo                 two passes over the 23 transcripts (~46 calls)
 *   npm run seed:demo -- --copies 1   one pass
 *   npm run seed:demo -- --wipe       remove all demo data (external_id 'demo-…') and exit
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ingestCall } from "../lib/pipeline/ingest";
import { processCall } from "../lib/pipeline/process";
import { mockProvider } from "../lib/booking/mock";
import { offerSlots } from "../lib/booking/service";
import { isAfterHours } from "../lib/hours";
import { istDate, istParts } from "../lib/time";
import type { Deps } from "../lib/deps";

const argv = process.argv.slice(2);
const copies = Number(argv.includes("--copies") ? argv[argv.indexOf("--copies") + 1] : 2);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Supabase env vars missing in .env.local"); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

async function wipe() {
  const { data: calls } = await db.from("calls").select("id").like("external_id", "demo-%");
  const ids = (calls ?? []).map((c) => c.id as string);
  const { data: leads } = ids.length ? await db.from("leads").select("id").in("call_id", ids) : { data: [] };
  const leadIds = (leads ?? []).map((l) => l.id as string);
  if (ids.length) await db.from("cost_events").delete().in("call_id", ids);
  if (leadIds.length) await db.from("notifications").delete().in("lead_id", leadIds);
  await db.from("bookings").delete().like("vaani_call_id", "demo-%");
  if (ids.length) await db.from("calls").delete().in("id", ids); // leads cascade
  console.log(`wiped ${ids.length} demo calls`);
}

const WOULD_BOOK = new Set(["T01", "T02", "T05", "T06", "T11", "T12", "T13", "T15", "T17", "T20", "S01", "S02", "S03"]);

async function main() {
  if (argv.includes("--wipe")) return wipe();

  // Illustrative unit prices, only where nothing real has been entered. Left flagged as placeholders so the dashboard says so.
  const demo: Record<string, number> = { price_vaani_inr_per_min: 9, price_llm_inr_per_m_input: 15, price_llm_inr_per_m_output: 60, price_sms_inr_per_message: 0.25, monthly_hosting_inr: 800 };
  for (const [k, v] of Object.entries(demo)) await db.from("settings").update({ value: v, description: "ILLUSTRATIVE demo value: replace with the real rate" }).eq("key", k).eq("value", 0);
  await db.from("settings").update({ value: 0.08 }).eq("key", "baseline_conversion_rate").is("value", null);

  const { count } = await db.from("designers").select("id", { count: "exact", head: true });
  if (!count) {
    await db.from("designers").insert([
      { name: "Demo Designer A (home)", specialisation: "home", areas_served: [], active: true },
      { name: "Demo Designer B (home)", specialisation: "home", areas_served: [], active: true },
      { name: "Demo Designer C (office)", specialisation: "office", areas_served: [], active: true },
      { name: "Demo Designer D (both)", specialisation: "both", areas_served: [], active: true },
    ]);
  }

  const files: { id: string; text: string }[] = [];
  for (const dir of ["phone", "synthetic"]) {
    const d = join(process.cwd(), "context", "transcripts", dir);
    for (const f of readdirSync(d).filter((x) => x.endsWith(".md")).sort()) files.push({ id: f.replace(".md", ""), text: readFileSync(join(d, f), "utf8").split("\n").slice(1).join("\n").trim() });
  }
  const jobs = Array.from({ length: copies }, () => files).flat().map((f, i) => ({ ...f, n: i }));
  console.log(`seeding ${jobs.length} calls over the last 28 days (real AI calls; ~${Math.ceil(jobs.length / 20)} min)…`);

  const today = istParts(new Date());
  let done = 0;
  for (const j of jobs) {
    // a random day in the last 28, mostly in working hours (a third after hours, as in the case)
    const day = Math.floor(rnd(1, 28));
    const after = Math.random() < 0.33;
    const mins = after ? pick([7 * 60 + 15, 8 * 60 + 40, 20 * 60 + 5, 21 * 60 + 30, 22 * 60 + 47, 23 * 60 + 10]) : Math.floor(rnd(10 * 60, 18 * 60 + 30));
    const at = istDate(today.y, today.m, today.d - day, mins);
    if (at.getTime() > Date.now() - 3600_000) { done++; continue; }

    let clock = at;
    const calendar = mockProvider({ now: () => clock });
    const deps: Deps = {
      now: () => clock, crm: null, booking: calendar,
      telegram: { send: async () => ({ message_id: 1 }), answerCallback: async () => {}, editMessage: async () => {} },
      sms: { name: "silent", send: async () => {} },
    };
    const phone = `+9198${String(10000000 + Math.floor(rnd(0, 89999999)))}`;
    const ext = `demo-${j.id}-${j.n}-${Date.now()}`;
    try {
      if (WOULD_BOOK.has(j.id) && Math.random() < 0.9) {
        const [slot] = await offerSlots(db as never, calendar, at);
        if (slot) await calendar.book({ start: slot, name: "Demo caller", phone, callRef: ext });
      }
      const end = new Date(at.getTime() + 4 * 60_000);
      const { callId } = await ingestCall(db, { channel: "phone", external_id: ext, caller_phone: phone, started_at: at.toISOString(), ended_at: end.toISOString(), duration_sec: 240, transcript: j.text, language: null, raw: { demo: true } });
      clock = end;
      const { leadId } = await processCall(db, deps, callId);
      // back-date everything the dashboard filters on
      await db.from("calls").update({ created_at: at.toISOString(), after_hours: isAfterHours(at) }).eq("id", callId);
      await db.from("leads").update({ created_at: end.toISOString() }).eq("id", leadId);
      await db.from("cost_events").update({ created_at: at.toISOString() }).eq("call_id", callId);
      await db.from("bookings").update({ created_at: at.toISOString() }).eq("lead_id", leadId);
      await outcome(leadId, at);
    } catch (e) {
      console.error(`  ${j.id} failed:`, e instanceof Error ? e.message : e);
    }
    process.stdout.write(`\r${++done}/${jobs.length}`);
  }
  // Safety: nothing from the demo may ever be sent by the live scheduler.
  const { data: leads } = await db.from("calls").select("id").like("external_id", "demo-%");
  const callIds = (leads ?? []).map((c) => c.id as string);
  const { data: ls } = callIds.length ? await db.from("leads").select("id").in("call_id", callIds) : { data: [] };
  if (ls?.length) await db.from("notifications").update({ cancelled_at: new Date().toISOString(), error: "demo seed" }).in("lead_id", ls.map((l) => l.id)).is("sent_at", null).is("cancelled_at", null);
  console.log("\ndone. Sign in and open /dashboard. Remove with: npm run seed:demo -- --wipe");
}

/** Make the history look lived-in: most handed-off leads get accepted, many contacted, some won or lost. */
async function outcome(leadId: string, callAt: Date) {
  const { data: l } = await db.from("leads").select("*").eq("id", leadId).single();
  if (!l) return;
  const after = (m: number) => new Date(new Date(l.created_at as string).getTime() + m * 60_000);
  if (l.status === "sent_to_designer" && Math.random() < 0.82) {
    const acceptAt = after(rnd(2, 38));
    const contacted = Math.random() < 0.8;
    const late = Math.random() < 0.2;
    const roll = Math.random();
    const status = !contacted ? "accepted" : roll < 0.22 ? "won" : roll < 0.5 ? "lost" : "contacted";
    const due = new Date((l.callback_due_at ?? l.sla_due_at ?? acceptAt.toISOString()) as string);
    await db.from("leads").update({
      status, accepted_at: acceptAt.toISOString(),
      first_response_at: contacted ? new Date(late ? due.getTime() + rnd(5, 90) * 60_000 : Math.min(due.getTime() - 60_000, acceptAt.getTime() + rnd(5, 40) * 60_000)).toISOString() : null,
      outcome_at: status === "won" || status === "lost" ? after(rnd(3000, 20000)).toISOString() : null,
    }).eq("id", leadId);
    await db.from("notifications").update({ acted_at: acceptAt.toISOString() }).eq("lead_id", leadId).eq("type", "lead_assigned");
    const r = Math.random();
    await db.from("bookings").update({ status: r < 0.75 ? "completed" : "no_show" }).eq("lead_id", leadId).eq("status", "confirmed");
  } else if (l.status === "in_review" && Math.random() < 0.6) {
    await db.from("leads").update({ status: Math.random() < 0.5 ? "closed" : "contacted", first_response_at: after(rnd(30, 600)).toISOString() }).eq("id", leadId);
    await db.from("bookings").update({ status: "cancelled" }).eq("lead_id", leadId).eq("status", "provisional");
  }
  void callAt;
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
