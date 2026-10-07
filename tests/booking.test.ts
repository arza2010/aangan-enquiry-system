import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, SETTINGS } from "./helpers/fakeDb";
import { mockProvider } from "@/lib/booking/mock";
import { calcomProvider, callerEmail } from "@/lib/booking/calcom";
import { pickSlots } from "@/lib/booking/slots";
import { bookSlot, cancelBooking, linkBookingToCall, offerSlots, syncBookingStatuses } from "@/lib/booking/service";
import { routeLead } from "@/lib/pipeline/route";
import { processDue } from "@/lib/notify/dispatch";
import type { Deps } from "@/lib/deps";
import { isWorkingTime } from "@/lib/time";

const ist = (s: string) => new Date(`${s}+05:30`);
const NOW = ist("2026-09-16T12:19:00"); // Wed
const H = { start: "10:00", end: "19:00" };
const DAYS = [1, 2, 3, 4, 5, 6];

const make = (now = NOW) => {
  let clock = now;
  const provider = mockProvider({ now: () => clock });
  const { db, tables } = fakeDb({ settings: SETTINGS, bookings: [], designers: [] });
  return { provider, db, tables, setNow: (d: Date) => (clock = d) };
};

describe("slot offering (brief §11)", () => {
  it("never offers a busy slot, an out-of-hours slot, <30 min away, or beyond 48h", async () => {
    const { provider, db } = make();
    const first = (await offerSlots(db, provider, NOW))[0];
    await provider.book({ start: first, name: "x", phone: "+919000000000", callRef: "other" }); // someone else holds the earliest
    const slots = await offerSlots(db, provider, NOW);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots.length).toBeLessThanOrEqual(3);
    expect(slots).not.toContain(first);
    for (const s of slots) {
      const t = new Date(s);
      expect(isWorkingTime(t, H, DAYS)).toBe(true);
      expect(t.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 30 * 60_000);
      expect(t.getTime()).toBeLessThanOrEqual(NOW.getTime() + 48 * 3600_000);
    }
  });

  it("prefers the earliest slot and spreads the rest at least 2 hours apart", () => {
    const starts = ["12:30", "13:00", "13:30", "14:30", "15:00", "17:00"].map((t) => ist(`2026-09-16T${t}:00`).toISOString());
    const picks = pickSlots(starts, NOW, { hours: H, workingDays: DAYS, minLeadMinutes: 30, horizonHours: 48 });
    // 12:30 is inside the 30-min lead time (cutoff 12:49) so the earliest valid is 13:00; then >=2h apart: 15:00, 17:00.
    expect(picks).toEqual(["13:00", "15:00", "17:00"].map((t) => ist(`2026-09-16T${t}:00`).toISOString()));
  });

  it("drops anything inside the 30-min lead time and anything after closing", () => {
    const starts = ["12:30", "13:00", "18:30", "19:00", "21:00"].map((t) => ist(`2026-09-16T${t}:00`).toISOString());
    const picks = pickSlots(starts, NOW, { hours: H, workingDays: DAYS, minLeadMinutes: 30, horizonHours: 48 });
    expect(picks).toEqual([ist("2026-09-16T13:00:00").toISOString(), ist("2026-09-16T18:30:00").toISOString()]);
  });

  it("night calls are offered the next working morning, never overnight", async () => {
    const night = ist("2026-09-09T22:47:00");
    const { provider, db } = make(night);
    const slots = await offerSlots(db, provider, night);
    expect(slots[0]).toBe(ist("2026-09-10T10:00:00").toISOString());
  });

  it("returns no slots (so the agent falls back to a callback window) when the calendar is full", async () => {
    const { db } = make();
    const empty = { ...mockProvider({ now: () => NOW }), getSlots: async () => [] };
    expect(await offerSlots(db, empty, NOW)).toEqual([]);
  });
});

describe("booking (brief §11)", () => {
  it("books a slot as provisional and records the provider id", async () => {
    const { provider, db, tables } = make();
    const [slot] = await offerSlots(db, provider, NOW);
    const r = await bookSlot(db, provider, { vaaniCallId: "v1", start: slot, name: "Priya", phone: "+919876543210" });
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expect(tables.bookings[0]).toMatchObject({ status: "provisional", vaani_call_id: "v1", provider: "mock", provider_booking_uid: "mock-1", slot_start: slot });
    expect(provider.all).toHaveLength(1);
  });

  it("is idempotent: the same call + slot twice yields one booking (a retried tool call never double-books)", async () => {
    const { provider, db, tables } = make();
    const [slot] = await offerSlots(db, provider, NOW);
    const a = await bookSlot(db, provider, { vaaniCallId: "v1", start: slot, name: "P", phone: "+919876543210" });
    const b = await bookSlot(db, provider, { vaaniCallId: "v1", start: slot, name: "P", phone: "+919876543210" });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(a.ok && b.ok && a.booking.id === b.booking.id).toBe(true);
    expect(tables.bookings).toHaveLength(1);
    expect(provider.all).toHaveLength(1);
  });

  it("rejects a second caller taking an already-booked slot", async () => {
    const { provider, db, tables } = make();
    const [slot] = await offerSlots(db, provider, NOW);
    await bookSlot(db, provider, { vaaniCallId: "v1", start: slot, name: "A", phone: "+919876543210" });
    const r = await bookSlot(db, provider, { vaaniCallId: "v2", start: slot, name: "B", phone: "+919876500000" });
    expect(r).toMatchObject({ ok: false, reason: "slot_taken" });
    expect(tables.bookings).toHaveLength(1);
  });

  it("cancelling removes it from the calendar and frees the slot", async () => {
    const { provider, db, tables } = make();
    const [slot] = await offerSlots(db, provider, NOW);
    const r = await bookSlot(db, provider, { vaaniCallId: "v1", start: slot, name: "A", phone: "+919876543210" });
    expect(r.ok && (await cancelBooking(db, provider, r.booking.id, "front desk"))).toMatchObject({ ok: true, providerError: null });
    expect(tables.bookings[0].status).toBe("cancelled");
    expect(provider.all[0].status).toBe("cancelled");
    expect(await offerSlots(db, provider, NOW)).toContain(slot); // free again
  });

  it("cancel still marks our row cancelled if Cal.com is unreachable, and reports the error", async () => {
    const { provider, db, tables } = make();
    const [slot] = await offerSlots(db, provider, NOW);
    const r = await bookSlot(db, provider, { vaaniCallId: "v1", start: slot, name: "A", phone: "+919876543210" });
    provider.cancel = async () => { throw new Error("cal down"); };
    const c = r.ok ? await cancelBooking(db, provider, r.booking.id, "x") : null;
    expect(c).toMatchObject({ ok: true, providerError: "cal down" });
    expect(tables.bookings[0].status).toBe("cancelled");
  });

  it("mirrors a cancellation the caller made from the Cal.com email", async () => {
    const { provider, db, tables } = make();
    const [slot] = await offerSlots(db, provider, NOW);
    await bookSlot(db, provider, { vaaniCallId: "v1", start: slot, name: "A", phone: "+919876543210" });
    await provider.cancel("mock-1", "caller cancelled");
    expect(await syncBookingStatuses(db, provider, NOW)).toMatchObject({ checked: 1, changed: 1 });
    expect(tables.bookings[0].status).toBe("cancelled");
  });
});

describe("linking a booking Vaani made natively in Cal.com", () => {
  const call = { id: "c1", external_id: "v1", caller_phone: "+919876543210", started_at: ist("2026-09-16T12:10:00").toISOString(), ended_at: ist("2026-09-16T12:16:00").toISOString(), duration_sec: 360 };

  it("finds the one booking created during the call window", async () => {
    const { provider, db, setNow } = make();
    setNow(ist("2026-09-16T12:13:00")); // booked mid-call
    await provider.book({ start: ist("2026-09-16T15:00:00").toISOString(), name: "Priya", phone: "+919876543210", callRef: "x" });
    const b = await linkBookingToCall(db, provider, call, "L1");
    expect(b).toMatchObject({ lead_id: "L1", call_id: "c1", status: "provisional", provider_booking_uid: "mock-1" });
  });

  it("ignores bookings made outside the call window", async () => {
    const { provider, db, setNow } = make();
    setNow(ist("2026-09-16T09:00:00"));
    await provider.book({ start: ist("2026-09-16T15:00:00").toISOString(), name: "Someone else", phone: "+919000000000", callRef: "x" });
    expect(await linkBookingToCall(db, provider, call, "L1")).toBeNull();
  });

  it("with two overlapping bookings, matches on phone; with no way to tell them apart, links nothing", async () => {
    const { provider, db, setNow } = make();
    setNow(ist("2026-09-16T12:12:00"));
    await provider.book({ start: ist("2026-09-16T15:00:00").toISOString(), name: "Other", phone: "+919111111111", callRef: "x" });
    await provider.book({ start: ist("2026-09-16T16:00:00").toISOString(), name: "Priya", phone: "+919876543210", callRef: "y" });
    expect((await linkBookingToCall(db, provider, call, "L1"))?.provider_booking_uid).toBe("mock-2");

    const b = make();
    b.setNow(ist("2026-09-16T12:12:00"));
    await b.provider.book({ start: ist("2026-09-16T15:00:00").toISOString(), name: "A", phone: "+919111111111", callRef: "x" });
    await b.provider.book({ start: ist("2026-09-16T16:00:00").toISOString(), name: "B", phone: "+919222222222", callRef: "y" });
    expect(await linkBookingToCall(b.db, b.provider, call, "L1")).toBeNull();
  });
});

describe("end to end: Vaani books in Cal.com, then the call is routed", () => {
  beforeEach(() => {
    process.env.TELEGRAM_FRONTDESK_CHAT_ID = "FD";
    process.env.TELEGRAM_NIKHIL_CHAT_ID = "NK";
    process.env.APP_BASE_URL = "https://app.test";
  });

  it("qualified lead: booking is found, confirmed, shown in the designer alert and caller SMS, with a 15-min reminder", async () => {
    let now = ist("2026-09-16T12:17:00");
    const provider = mockProvider({ now: () => ist("2026-09-16T12:13:00") });
    const slot = ist("2026-09-16T15:00:00").toISOString();
    await provider.book({ start: slot, name: "Priya Shah", phone: "+919876543210", callRef: "v1" });

    const { db, tables } = fakeDb({
      settings: SETTINGS.map((r) => (r.key === "digest_time" ? { ...r, value: "23:59" } : r)),
      designers: [{ id: "dA", name: "Anaya", active: true, specialisation: "home", areas_served: [], telegram_chat_id: "A", night_alerts: false }],
      calls: [{ id: "c1", external_id: "v1", caller_phone: "+919876543210", started_at: ist("2026-09-16T12:10:00").toISOString(), ended_at: ist("2026-09-16T12:16:00").toISOString(), duration_sec: 360 }],
      leads: [{ id: "L1", call_id: "c1", call_type: "new_enquiry", status: "new", classification: "qualified", caller_name: "Priya Shah", project_type: "home", location: "Baner", possession_status: "ready", missing_info: [], handoff_note: "Full redesign." }],
    });
    const sent: { chat: string; text: string }[] = [];
    const sms: string[] = [];
    const deps: Deps = {
      telegram: { send: vi.fn(async (chat: string, text: string) => (sent.push({ chat, text }), { message_id: 1 })), answerCallback: vi.fn(), editMessage: vi.fn() },
      sms: { name: "t", send: async (_t: string, text: string) => void sms.push(text) },
      crm: null, booking: provider, now: () => now,
    };

    await routeLead(db, deps, "L1");
    expect(tables.bookings[0]).toMatchObject({ status: "confirmed", designer_id: "dA", lead_id: "L1" });
    await processDue(db, deps);
    const alert = sent.find((m) => m.chat === "A")!.text;
    expect(alert).toContain("Booked call: 3:00 pm");
    expect(alert).toContain("NEW LEAD — consult booked 3:00 pm (in 163 min) · accept by 12:47 pm");
    expect(sms[0]).toContain("booked for 3:00 pm");

    now = ist("2026-09-16T14:45:00"); // 15 min before
    await processDue(db, deps);
    expect(sent.some((m) => m.chat === "A" && m.text.startsWith("📅 Call with Priya Shah at 3:00 pm"))).toBe(true);
  });

  it("a Cal.com outage never stops routing: the lead is still alerted, with a callback promise instead", async () => {
    const provider = mockProvider({ now: () => NOW });
    provider.listCreatedBetween = async () => { throw new Error("cal.com 503"); };
    const { db, tables } = fakeDb({
      settings: SETTINGS,
      designers: [{ id: "dA", name: "Anaya", active: true, specialisation: "home", areas_served: [], telegram_chat_id: "A", night_alerts: false }],
      calls: [{ id: "c1", external_id: "v1", caller_phone: "+919876543210", started_at: NOW.toISOString(), ended_at: NOW.toISOString(), duration_sec: 60 }],
      leads: [{ id: "L1", call_id: "c1", call_type: "new_enquiry", status: "new", classification: "qualified", project_type: "home", location: "Baner", possession_status: "ready", missing_info: [] }],
    });
    const deps: Deps = { telegram: { send: vi.fn(async () => ({ message_id: 1 })), answerCallback: vi.fn(), editMessage: vi.fn() }, sms: { name: "t", send: async () => {} }, crm: null, booking: provider, now: () => NOW };
    expect(await routeLead(db, deps, "L1")).toMatchObject({ outcome: "assigned" });
    expect(tables.bookings).toHaveLength(0);
  });
});

describe("attendee email", () => {
  it("plus-addresses the studio mailbox, one distinct address per caller", () => {
    expect(callerEmail("frontdesk@aangan.studio", "+91 98765-43210")).toBe("frontdesk+caller919876543210@aangan.studio");
    expect(callerEmail("front+old@aangan.studio", "+919876543210")).toBe("front+caller919876543210@aangan.studio");
    expect(() => callerEmail("not-an-email", "+91")).toThrow();
  });
});

describe("Cal.com HTTP provider", () => {
  const calls: { method: string; url: URL; headers: Record<string, string>; body?: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({ method: init.method!, url: u, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (u.pathname === "/v2/slots") return new Response(JSON.stringify({ status: "success", data: { "2026-09-16": [{ start: "2026-09-16T10:00:00.000+05:30" }, { start: "2026-09-16T10:30:00.000+05:30" }] } }));
    if (u.pathname === "/v2/bookings" && init.method === "POST") return new Response(JSON.stringify({ status: "success", data: { uid: "U1", start: "2026-09-16T09:30:00.000Z", end: "2026-09-16T09:50:00.000Z", status: "accepted", attendees: [{ name: "Priya", phoneNumber: "+919876543210" }] } }), { status: 201 });
    if (u.pathname === "/v2/bookings") return new Response(JSON.stringify({ data: [{ uid: "U1", start: "2026-09-16T09:30:00Z", end: "2026-09-16T09:50:00Z", status: "accepted", createdAt: "2026-09-16T06:45:00Z", attendees: [{ name: "Priya", phoneNumber: "+919876543210" }] }] }));
    if (u.pathname === "/v2/bookings/GONE") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ status: "success", data: { uid: "U1", start: "2026-09-16T09:30:00Z", end: "2026-09-16T09:50:00Z", status: "cancelled" } }));
  }) as unknown as typeof fetch;
  const p = calcomProvider({ apiKey: "cal_live_x", eventTypeId: 42, attendeeEmail: "frontdesk@callers.test", f });

  it("slots: sends the right version header and parses the per-day map to sorted UTC", async () => {
    expect(await p.getSlots("2026-09-16T04:00:00.000Z", "2026-09-18T04:00:00.000Z")).toEqual(["2026-09-16T04:30:00.000Z", "2026-09-16T05:00:00.000Z"]);
    const c = calls.at(-1)!;
    expect(c.headers["cal-api-version"]).toBe("2024-09-04");
    expect(c.headers.authorization).toBe("Bearer cal_live_x");
    expect(c.url.searchParams.get("eventTypeId")).toBe("42");
    expect(c.url.searchParams.get("timeZone")).toBe("Asia/Kolkata");
  });
  it("book: maps the caller to an attendee with a synthetic email and a phone number", async () => {
    const r = await p.book({ start: "2026-09-16T09:30:00.000Z", name: "Priya", phone: "+919876543210", callRef: "v1" });
    expect(r.uid).toBe("U1");
    const c = calls.at(-1)!;
    expect(c.headers["cal-api-version"]).toBe("2026-02-25");
    expect(c.body).toMatchObject({ eventTypeId: 42, start: "2026-09-16T09:30:00.000Z", attendee: { name: "Priya", email: "frontdesk+caller919876543210@callers.test", phoneNumber: "+919876543210", timeZone: "Asia/Kolkata" } });
  });
  it("cancel, get and list use the documented endpoints", async () => {
    await p.cancel("U1", "front desk");
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { cancellationReason: "front desk" } });
    expect(calls.at(-1)!.url.pathname).toBe("/v2/bookings/U1/cancel");
    expect(await p.get("GONE")).toBeNull();
    const l = await p.listCreatedBetween("2026-09-16T06:40:00Z", "2026-09-16T06:50:00Z");
    expect(l[0]).toMatchObject({ uid: "U1", attendeePhone: "+919876543210" });
    expect(calls.at(-1)!.headers["cal-api-version"]).toBe("2026-05-01");
    expect(calls.at(-1)!.url.searchParams.get("afterCreatedAt")).toBe("2026-09-16T06:40:00Z");
  });
});
