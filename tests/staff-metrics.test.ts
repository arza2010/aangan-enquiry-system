import { describe, expect, it, vi } from "vitest";
import { fakeDb, SETTINGS } from "./helpers/fakeDb";
import { computeMetrics, median } from "@/lib/metrics";
import { cancelHeldBooking, closeLead, keepBooking, markContacted, sendToDesigner, setOutcome } from "@/lib/staff-actions";
import { mockProvider } from "@/lib/booking/mock";
import type { Deps } from "@/lib/deps";

const T = (m: number) => new Date(Date.UTC(2026, 8, 16, 6, 0) + m * 60_000).toISOString();

describe("dashboard metrics", () => {
  const base = {
    calls: [
      { id: "c1", started_at: T(0), ended_at: T(5), after_hours: false, repeat_caller: false },
      { id: "c2", started_at: T(10), ended_at: T(15), after_hours: true, repeat_caller: true },
      { id: "c3", started_at: T(20), ended_at: T(25), after_hours: true, repeat_caller: false },
    ],
    leads: [
      { id: "L1", call_id: "c1", call_type: "new_enquiry", classification: "qualified", status: "won", accepted_at: T(25), first_response_at: T(40), callback_due_at: T(65), assigned_designer_id: "d" },
      { id: "L2", call_id: "c2", call_type: "new_enquiry", classification: "qualified", status: "sent_to_designer", accepted_at: null, first_response_at: T(100), callback_due_at: T(60), assigned_designer_id: "d" },
      { id: "L3", call_id: "c3", call_type: "existing_client", classification: "borderline", status: "in_review" },
    ],
    bookings: [{ lead_id: "L1", status: "completed" }, { lead_id: "L2", status: "cancelled" }, { lead_id: "L3", status: "no_show" }],
    notifications: [
      { lead_id: "L1", type: "new_enquiry", sent_at: T(7) }, { lead_id: "L1", type: "lead_assigned", sent_at: T(10) },
      { lead_id: "L2", type: "new_enquiry", sent_at: T(30) }, { lead_id: "L2", type: "lead_assigned", sent_at: T(31) },
    ],
    costs: [{ service: "vaani", cost_inr: 10 }, { service: "llm", cost_inr: 4 }, { service: "sms", cost_inr: 1 }],
    settings: { monthly_hosting_inr: 300, baseline_conversion_rate: 0.1, project_value_range_lakh: { min: 8, max: 14 } },
    days: 30,
  };
  const m = computeMetrics(base);
  it("counts calls, after-hours and repeat callers", () => expect(m).toMatchObject({ callsReceived: 3, afterHoursCaptured: 2, repeatCallers: 1 }));
  it("alert speed: % of calls the front desk heard about within 5 minutes", () => expect(m.pctAlertedWithin5Min).toBe(50)); // L1: 2 min yes; L2: 15 min no; L3 no alert
  it("classification mix treats non-enquiries separately", () => expect(m.classes).toMatchObject({ qualified: 2, other: 1 }));
  it("median accept time from call end and from the alert", () => {
    expect(m.medianMinToAccept).toBe(20);
    expect(m.medianMinAlertToAccept).toBe(15);
  });
  it("callbacks made before the promised time", () => expect(m.pctCallbacksOnTime).toBe(50));
  it("consults: booked % of qualified, completed vs no-show, cancelled excluded", () => {
    expect(m.consultsBookedPct).toBe(50);
    expect(m).toMatchObject({ consultsCompleted: 1, consultsNoShow: 1 });
  });
  it("conversion vs baseline (fraction or percent)", () => expect(m).toMatchObject({ won: 1, conversionPct: 50, baselineConversionPct: 10 }));
  it("cost: variable + hosting, per call and per qualified lead", () => {
    expect(m.cost.total).toBe(315);
    expect(m.cost.perCall).toBe(105);
    expect(m.cost.perQualified).toBe(157.5);
  });
  it("hosting is prorated to the period; pipeline is qualified x the indicative range", () => {
    expect(computeMetrics({ ...base, days: 15 }).cost.hosting).toBe(150);
    expect(m.pipeline).toMatchObject({ minLakh: 16, maxLakh: 28 });
  });
  it("is safe on an empty period", () => {
    const e = computeMetrics({ calls: [], leads: [], bookings: [], notifications: [], costs: [], settings: {}, days: 30 });
    expect(e.callsReceived).toBe(0);
    expect(e.pctAlertedWithin5Min).toBeNull();
    expect(e.cost.perCall).toBeNull();
  });
  it("median", () => { expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNull(); });
});

describe("staff actions", () => {
  const NOW = new Date("2026-09-16T06:49:00Z");
  const setup = () => {
    const provider = mockProvider({ now: () => NOW });
    const { db, tables } = fakeDb({
      settings: SETTINGS,
      designers: [{ id: "dA", name: "Anaya", active: true, specialisation: "home", areas_served: [], telegram_chat_id: "A", night_alerts: false }, { id: "dX", name: "Away", active: false, specialisation: "home", areas_served: [], telegram_chat_id: "X", night_alerts: false }],
      calls: [{ id: "c1", caller_phone: "+919876543210", external_id: "v1", started_at: NOW.toISOString() }],
      leads: [{ id: "L1", call_id: "c1", call_type: "new_enquiry", status: "in_review", classification: "borderline", needs_review: true, review_reason: "x", caller_name: "Priya", project_type: "home", location: "Baner", possession_status: "ready", missing_info: [] }],
      bookings: [{ id: "b1", lead_id: "L1", vaani_call_id: "v1", slot_start: "2026-09-16T10:00:00.000Z", slot_end: "2026-09-16T10:20:00.000Z", status: "provisional", provider: "mock", provider_booking_uid: "mock-1", caller_phone: "+919876543210" }],
    });
    provider.all.push({ uid: "mock-1", start: "2026-09-16T10:00:00.000Z", end: "2026-09-16T10:20:00.000Z", status: "accepted", createdAt: NOW.toISOString() });
    process.env.TELEGRAM_FRONTDESK_CHAT_ID = "FD"; process.env.TELEGRAM_NIKHIL_CHAT_ID = "NK"; process.env.APP_BASE_URL = "https://app.test";
    const sent: { chat: string; text: string }[] = []; const sms: string[] = [];
    const deps: Deps = {
      telegram: { send: vi.fn(async (chat: string, text: string) => (sent.push({ chat, text }), { message_id: 1 })), answerCallback: vi.fn(), editMessage: vi.fn() },
      sms: { name: "t", send: async (_t: string, text: string) => void sms.push(text) }, crm: null, booking: provider, now: () => NOW,
    };
    return { db, tables, deps, sent, sms, provider };
  };

  it("send to designer: assigns, confirms the held consult, alerts the designer, clears the review flag", async () => {
    const s = setup();
    expect(await sendToDesigner(s.db, s.deps, "L1", "dA")).toMatchObject({ ok: true });
    expect(s.tables.leads[0]).toMatchObject({ status: "sent_to_designer", assigned_designer_id: "dA", needs_review: false });
    expect(s.tables.bookings[0].status).toBe("confirmed");
    expect(s.sent.some((m) => m.chat === "A" && m.text.includes("NEW LEAD"))).toBe(true);
  });
  it("send to designer refuses an inactive designer", async () => {
    const s = setup();
    expect(await sendToDesigner(s.db, s.deps, "L1", "dX")).toMatchObject({ ok: false });
    expect(s.tables.leads[0].status).toBe("in_review");
  });
  it("keep confirms a held booking; a second Keep is a no-op", async () => {
    const s = setup();
    expect(await keepBooking(s.db, "b1")).toMatchObject({ ok: true });
    expect(await keepBooking(s.db, "b1")).toMatchObject({ ok: false });
  });
  it("cancel: removes it from Cal.com, frees the slot, texts the caller politely (no price, no promise)", async () => {
    const s = setup();
    expect(await cancelHeldBooking(s.db, s.deps, "b1")).toMatchObject({ ok: true });
    expect(s.tables.bookings[0].status).toBe("cancelled");
    expect(s.provider.all[0].status).toBe("cancelled");
    expect(s.sms).toHaveLength(1);
    expect(s.sms[0]).toMatch(/unable to go ahead/);
    expect(s.sms[0]).not.toMatch(/₹|lakh|per sq/i);
    expect(await cancelHeldBooking(s.db, s.deps, "b1")).toMatchObject({ ok: false, message: "Already cancelled" });
    expect(s.sms).toHaveLength(1);
  });
  it("mark contacted stamps first response once; won/lost stamp the outcome; close cancels pending alerts", async () => {
    const s = setup();
    await markContacted(s.db, s.deps, "L1");
    expect(s.tables.leads[0]).toMatchObject({ status: "contacted", first_response_at: NOW.toISOString(), hubspot_sync_status: "pending" });
    await setOutcome(s.db, s.deps, "L1", "won");
    expect(s.tables.leads[0]).toMatchObject({ status: "won", outcome_at: NOW.toISOString() });
    await closeLead(s.db, s.deps, "L1");
    expect(s.tables.leads[0].status).toBe("closed");
  });
});
