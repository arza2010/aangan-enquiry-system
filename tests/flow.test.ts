import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, SETTINGS } from "./helpers/fakeDb";
import type { Deps } from "@/lib/deps";
import { routeLead } from "@/lib/pipeline/route";
import { processDue } from "@/lib/notify/dispatch";
import { acceptLead, reassignLead } from "@/lib/lead-actions";
import { hasPriceLeak } from "@/lib/ai/priceGuard";

const FD = "FD-chat";
const NK = "NK-chat";
const min = (n: number) => n * 60_000;

// Wed 16 Sep 2026, 12:19 IST (working hours) and Wed 9 Sep 22:47 IST (quiet hours, after hours)
const DAY = new Date("2026-09-16T06:49:00Z");
const NIGHT = new Date("2026-09-09T17:17:00Z");

function setup(opts: { digestTime?: string; now: Date; designers?: Record<string, unknown>[]; lead?: Record<string, unknown>; booking?: Record<string, unknown> | null; phone?: string }) {
  const designers = opts.designers ?? [
    { id: "dA", name: "Anaya", active: true, specialisation: "home", areas_served: ["baner"], telegram_chat_id: "A-chat", night_alerts: false },
    { id: "dB", name: "Bhavin", active: true, specialisation: "home", areas_served: ["baner"], telegram_chat_id: "B-chat", night_alerts: false },
    { id: "dC", name: "Chitra", active: true, specialisation: "office", areas_served: ["baner"], telegram_chat_id: "C-chat", night_alerts: false },
  ];
  const { db, tables } = fakeDb({
    // The digest fires on any tick after digest_time; park it late so it does not add noise to unrelated tests.
    settings: SETTINGS.map((r) => (r.key === "digest_time" ? { ...r, value: opts.digestTime ?? "23:59" } : r)),
    designers,
    calls: [{ id: "c1", caller_phone: opts.phone ?? "+919876543210", external_id: "v1", started_at: opts.now.toISOString() }],
    // Bhavin already has one open lead, so Anaya should win the tie-break on load.
    leads: [
      { id: "old", call_id: "c0", call_type: "new_enquiry", assigned_designer_id: "dB", status: "accepted" },
      {
        id: "L1", call_id: "c1", call_type: "new_enquiry", status: "new", classification: "qualified", caller_name: "Priya Shah", project_type: "home", location: "Baner",
        carpet_area_sqft: 1100, bhk_or_rooms: "3BHK", budget_range: null, timeline: "by March", possession_status: "ready",
        handoff_note: "Wants a full 3BHK redesign. Referral from a past client.", missing_info: ["budget"], review_reason: null, ...opts.lead,
      },
    ],
    bookings: opts.booking ? [opts.booking] : [],
  });
  let now = opts.now;
  const sent: { chat: string; text: string; buttons?: unknown }[] = [];
  const sms: { to: string; text: string }[] = [];
  const failNext = { telegram: false };
  const deps: Deps = {
    telegram: {
      send: vi.fn(async (chat: string, text: string, buttons?: unknown) => {
        if (failNext.telegram) throw new Error("telegram down");
        sent.push({ chat, text, buttons });
        return { message_id: sent.length };
      }),
      answerCallback: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
    },
    sms: { name: "test", send: vi.fn(async (to: string, text: string) => void sms.push({ to, text })) },
    crm: null,
    now: () => now,
  };
  return { db, tables, deps, sent, sms, failNext, advance: (ms: number) => (now = new Date(now.getTime() + ms)), setNow: (d: Date) => (now = d) };
}

beforeEach(() => {
  process.env.TELEGRAM_FRONTDESK_CHAT_ID = FD;
  process.env.TELEGRAM_NIKHIL_CHAT_ID = NK;
  process.env.APP_BASE_URL = "https://app.test";
});

describe("routing (brief §11)", () => {
  it("qualified lead goes to the matching designer with the fewest open leads", async () => {
    const s = setup({ now: DAY });
    const r = await routeLead(s.db, s.deps, "L1");
    expect(r).toMatchObject({ routed: true, outcome: "assigned", designerId: "dA" }); // not Chitra (office), not Bhavin (busier)
    const lead = s.tables.leads.find((l) => l.id === "L1")!;
    expect(lead).toMatchObject({ status: "sent_to_designer", assigned_designer_id: "dA" });
    expect(new Date(lead.sla_due_at as string).getTime()).toBe(DAY.getTime() + min(30));
  });

  it("no active designer -> front desk is alerted, nobody is dropped", async () => {
    const s = setup({ now: DAY, designers: [{ id: "dX", name: "Away", active: false, specialisation: "both", areas_served: [], telegram_chat_id: "X", night_alerts: false }] });
    const r = await routeLead(s.db, s.deps, "L1");
    expect(r).toMatchObject({ outcome: "review", designerId: null });
    await processDue(s.db, s.deps);
    const texts = s.sent.map((m) => `${m.chat}: ${m.text}`).join("\n");
    expect(texts).toContain(`${FD}: ⚠️ <b>Needs review:</b> no active designer`);
    expect(s.sent.some((m) => m.chat === "X")).toBe(false);
    expect(s.sms).toHaveLength(1); // caller still told the enquiry was received
    expect(s.tables.leads.find((l) => l.id === "L1")).toMatchObject({ status: "in_review", needs_review: true });
  });

  it("borderline / not qualified / price-flagged go to the review queue, not a designer", async () => {
    const s = setup({ now: DAY, lead: { status: "in_review", classification: "borderline", needs_review: true, review_reason: "classified borderline; price mentioned in call" } });
    expect(await routeLead(s.db, s.deps, "L1")).toMatchObject({ outcome: "review", designerId: null });
    await processDue(s.db, s.deps);
    expect(s.sent.filter((m) => m.chat !== FD)).toHaveLength(0);
    expect(s.sent.map((m) => m.text).join("\n")).toContain("price mentioned in call");
  });

  it("existing-client complaint escalates to Nikhil and is never given to a designer", async () => {
    const s = setup({ now: DAY, lead: { call_type: "existing_client", status: "in_review", classification: "borderline", needs_review: true, handoff_note: "Frustrated: no reply in five days." } });
    expect(await routeLead(s.db, s.deps, "L1")).toMatchObject({ outcome: "escalated" });
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.chat === NK && m.text.includes("senior callback"))).toBe(true);
    expect(s.sent.some((m) => ["A-chat", "B-chat", "C-chat"].includes(m.chat))).toBe(false);
    expect(s.sms).toHaveLength(0); // no "enquiry received" text to an existing client
  });

  it("is idempotent: routing twice sends one set of alerts", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    expect(await routeLead(s.db, s.deps, "L1")).toMatchObject({ routed: false });
    await processDue(s.db, s.deps);
    expect(s.sent.filter((m) => m.chat === FD)).toHaveLength(1);
    expect(s.sent.filter((m) => m.chat === "A-chat")).toHaveLength(1);
  });

  it("a booked designer keeps the lead, the booking is confirmed, and a 15-min call reminder is queued", async () => {
    const slot = new Date(DAY.getTime() + min(120));
    const s = setup({ now: DAY, booking: { id: "b1", lead_id: "L1", designer_id: "dB", slot_start: slot.toISOString(), slot_end: new Date(slot.getTime() + min(20)).toISOString(), status: "provisional" } });
    await routeLead(s.db, s.deps, "L1");
    expect(s.tables.leads.find((l) => l.id === "L1")!.assigned_designer_id).toBe("dB");
    expect(s.tables.bookings[0].status).toBe("confirmed");
    s.advance(min(105)); // 15 min before the call
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.chat === "B-chat" && m.text.startsWith("📅 Call with Priya Shah"))).toBe(true);
    expect(s.sms[0].text).toContain("booked for"); // caller SMS confirms the booked time
  });

  it("unrouted review leads keep a provisional booking provisional", async () => {
    const slot = new Date(DAY.getTime() + min(120));
    const s = setup({ now: DAY, lead: { status: "in_review", classification: "borderline", needs_review: true }, booking: { id: "b1", lead_id: "L1", designer_id: "dB", slot_start: slot.toISOString(), slot_end: slot.toISOString(), status: "provisional" } });
    await routeLead(s.db, s.deps, "L1");
    expect(s.tables.bookings[0].status).toBe("provisional");
  });
});

describe("notifications (brief §8A, §11)", () => {
  it("sends the designer alert immediately, with Accept/Reassign, urgency copy and no price figures", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    const a = s.sent.find((m) => m.chat === "A-chat")!;
    expect(a.text).toContain("NEW LEAD — call by");
    expect(a.text).toContain("(in 30 min)");
    expect(a.text).toContain("Calls within 1 hr convert 4× better");
    expect(a.text).toContain("Indicative project value: ₹8–14L");
    expect(a.text).toContain("Priya Shah");
    expect(a.text).toContain("Still to ask: budget");
    expect(JSON.stringify(a.buttons)).toContain(`a:L1`);
    expect(JSON.stringify(a.buttons)).toContain(`r:L1`);
    // The only currency text allowed is the labelled indicative project value; the note itself is clean.
    expect(hasPriceLeak(a.text.replace(/Indicative project value: ₹8–14L \(indicative only\)\./, ""))).toBe(false);
    const fd = s.sent.find((m) => m.chat === FD)!;
    expect(fd.text).toMatch(/^📞 <b>New enquiry<\/b> — 12:19 pm · Home, Baner · qualified → Anaya · Due: 12:49 pm/);
  });

  it("reminder fires at 10 min, escalation at the SLA, and both only if still unaccepted", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    const before = s.sent.length;

    s.advance(min(9));
    await processDue(s.db, s.deps);
    expect(s.sent.length).toBe(before); // nothing yet at 9 min

    s.advance(min(1)); // 10 min
    await processDue(s.db, s.deps);
    const rem = s.sent.slice(before);
    expect(rem).toHaveLength(1);
    expect(rem[0]).toMatchObject({ chat: "A-chat" });
    expect(rem[0].text).toMatch(/⏰ <b>Reminder:<\/b> Priya Shah is waiting\. Due in 20 min\./);

    s.advance(min(19)); // 29 min
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.text.includes("Overdue"))).toBe(false);

    s.advance(min(1)); // 30 min = SLA
    await processDue(s.db, s.deps);
    const esc = s.sent.filter((m) => m.text.includes("Overdue"));
    expect(esc.map((m) => m.chat).sort()).toEqual([FD, NK]);
    expect(esc[0].text).toContain("Anaya hasn't accepted. Reassign?");
    expect(JSON.stringify(esc[0].buttons)).toContain("r:L1");
  });

  it("Accept cancels the reminder and the escalation and stamps the alert for alert-to-accept time", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    s.advance(min(4));
    expect(await acceptLead(s.db, s.deps, "L1", "A-chat")).toMatchObject({ ok: true });
    s.advance(min(60));
    const before = s.sent.length;
    await processDue(s.db, s.deps);
    expect(s.sent.length).toBe(before); // no reminder, no escalation
    const lead = s.tables.leads.find((l) => l.id === "L1")!;
    expect(lead).toMatchObject({ status: "accepted", hubspot_sync_status: "pending" });
    expect(s.tables.notifications.find((n) => n.type === "lead_assigned")!.acted_at).toBeTruthy();
  });

  it("only the assigned designer, front desk or Nikhil may Accept", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    expect(await acceptLead(s.db, s.deps, "L1", "B-chat")).toMatchObject({ ok: false });
    expect(await acceptLead(s.db, s.deps, "L1", FD)).toMatchObject({ ok: true });
  });

  it("quiet hours: designer alert for an after-hours call is queued until 8am, front desk is told at once", async () => {
    const s = setup({ now: NIGHT });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.chat === FD)).toBe(true);
    expect(s.sent.some((m) => m.chat === "A-chat")).toBe(false); // queued, not sent at 22:47

    const queued = s.tables.notifications.find((n) => n.type === "lead_assigned")!;
    expect(queued.scheduled_for).toBe("2026-09-10T02:30:00.000Z"); // 08:00 IST Thu
    expect(queued.sent_at).toBeNull();

    s.setNow(new Date("2026-09-10T02:30:00Z"));
    await processDue(s.db, s.deps);
    const a = s.sent.find((m) => m.chat === "A-chat")!;
    expect(a.text).toContain("NEW LEAD — call by 10:30 am (in 150 min)"); // after-hours SLA: 10:30 next morning, counted from when the alert lands
    const lead = s.tables.leads.find((l) => l.id === "L1")!;
    expect(lead.sla_due_at).toBe("2026-09-10T05:00:00.000Z"); // 10:30 IST
    // reminder is 10 min after the alert actually lands, not 10 min after the call
    expect(s.tables.notifications.find((n) => n.type === "reminder")!.scheduled_for).toBe("2026-09-10T02:40:00.000Z");
  });

  it("a designer who opted in to night alerts is alerted immediately", async () => {
    const s = setup({ now: NIGHT, designers: [{ id: "dA", name: "Anaya", active: true, specialisation: "home", areas_served: ["baner"], telegram_chat_id: "A-chat", night_alerts: true }] });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.chat === "A-chat")).toBe(true);
  });

  it("a failed Telegram send is retried with backoff, then given up on visibly, never silently lost", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    s.failNext.telegram = true;
    const r1 = await processDue(s.db, s.deps);
    expect(r1.failed).toBeGreaterThan(0);
    const n = s.tables.notifications.find((x) => x.type === "lead_assigned")!;
    expect(n).toMatchObject({ attempts: 1, error: "telegram down" });
    expect(n.sent_at).toBeNull();
    expect(new Date(n.scheduled_for as string).getTime()).toBe(DAY.getTime() + min(2)); // 2^1 minutes

    s.failNext.telegram = false;
    s.advance(min(2));
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.chat === "A-chat")).toBe(true);
  });

  it("two overlapping runs never send the same alert twice", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    await Promise.all([processDue(s.db, s.deps), processDue(s.db, s.deps), processDue(s.db, s.deps)]);
    expect(s.sent.filter((m) => m.chat === "A-chat")).toHaveLength(1);
    expect(s.sent.filter((m) => m.chat === FD)).toHaveLength(1);
    expect(s.sms).toHaveLength(1);
  });

  it("queues the daily digest once, after 09:30 IST", async () => {
    const s = setup({ now: new Date("2026-09-16T03:59:00Z"), digestTime: "09:30" }); // 09:29 IST
    await processDue(s.db, s.deps);
    expect(s.tables.notifications.filter((n) => n.type === "digest")).toHaveLength(0);
    s.setNow(new Date("2026-09-16T04:01:00Z")); // 09:31 IST
    await processDue(s.db, s.deps);
    await processDue(s.db, s.deps); // second tick same day: no duplicate
    const d = s.sent.filter((m) => m.text.includes("Overnight digest"));
    expect(d.map((m) => m.chat).sort()).toEqual([FD, NK]);
  });

  it("logs a cost event for every message sent", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    const services = s.tables.cost_events.map((c) => c.service);
    expect(services.filter((x) => x === "telegram")).toHaveLength(2);
    expect(services.filter((x) => x === "sms")).toHaveLength(1);
    expect(s.tables.cost_events.find((c) => c.service === "sms")!.cost_inr).toBe(0.2);
  });

  it("uses a plain link, not a URL button, when the app URL is not public https", async () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    const fd = s.sent.find((m) => m.chat === FD)!;
    expect(JSON.stringify(fd.buttons ?? [])).not.toContain("url");
    expect(fd.text).toContain("http://localhost:3000/leads/L1");
  });
});

describe("reassign", () => {
  it("moves the lead to the next matching designer and silences the old designer's pending alerts", async () => {
    const s = setup({ now: DAY });
    await routeLead(s.db, s.deps, "L1");
    await processDue(s.db, s.deps);
    s.advance(min(3));
    const r = await reassignLead(s.db, s.deps, "L1", "A-chat");
    expect(r).toMatchObject({ ok: true, designerName: "Bhavin" });
    expect(s.tables.leads.find((l) => l.id === "L1")!.assigned_designer_id).toBe("dB");
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.chat === "B-chat" && m.text.includes("NEW LEAD"))).toBe(true);
    s.advance(min(11));
    await processDue(s.db, s.deps);
    expect(s.sent.filter((m) => m.chat === "A-chat" && m.text.includes("Reminder"))).toHaveLength(0);
    expect(s.sent.filter((m) => m.chat === "B-chat" && m.text.includes("Reminder"))).toHaveLength(1);
  });

  it("no other designer -> front desk is told, lead stays put", async () => {
    const s = setup({ now: DAY, designers: [{ id: "dA", name: "Anaya", active: true, specialisation: "home", areas_served: ["baner"], telegram_chat_id: "A-chat", night_alerts: false }] });
    await routeLead(s.db, s.deps, "L1");
    const r = await reassignLead(s.db, s.deps, "L1", "A-chat");
    expect(r.ok).toBe(false);
    expect(s.tables.leads.find((l) => l.id === "L1")!.assigned_designer_id).toBe("dA");
    await processDue(s.db, s.deps);
    expect(s.sent.some((m) => m.chat === FD && m.text.includes("reassign requested"))).toBe(true);
  });
});
