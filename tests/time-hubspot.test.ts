import { describe, expect, it, vi } from "vitest";
import { afterQuietHours, computeCallbackDue, computeSlaDue, fmtTime, fmtWhen, inQuietHours, isWorkingTime, nextOccurrence, type TimingSettings } from "@/lib/time";
import { pickDesigner, servesArea, type DesignerRow } from "@/lib/routing";
import { hubspotClient } from "@/lib/crm/hubspot";
import { syncLead } from "@/lib/crm/sync";
import { fakeDb } from "./helpers/fakeDb";
import * as T from "@/lib/notify/templates";
import { hasPriceLeak } from "@/lib/ai/priceGuard";

const T0: TimingSettings = { hours: { start: "10:00", end: "19:00" }, workingDays: [1, 2, 3, 4, 5, 6], slaMinutes: 30, afterHoursDeadline: "10:30", callbackMinutes: 60, afterHoursCallback: "11:00" };
const ist = (s: string) => new Date(`${s}+05:30`);

describe("time (Asia/Kolkata)", () => {
  it("SLA: in hours = +30 min", () => expect(computeSlaDue(ist("2026-09-16T12:19:00"), T0)).toEqual(ist("2026-09-16T12:49:00")));
  it("SLA: a call that would overrun closing time rolls to next morning 10:30", () => expect(computeSlaDue(ist("2026-09-16T18:45:00"), T0)).toEqual(ist("2026-09-17T10:30:00")));
  it("SLA: after-hours evening -> next working morning 10:30", () => expect(computeSlaDue(ist("2026-09-09T22:47:00"), T0)).toEqual(ist("2026-09-10T10:30:00")));
  it("SLA: early-morning call -> same day 10:30", () => expect(computeSlaDue(ist("2026-09-16T06:10:00"), T0)).toEqual(ist("2026-09-16T10:30:00")));
  it("SLA: Saturday evening skips Sunday (if Sunday is closed)", () => expect(computeSlaDue(ist("2026-09-19T20:00:00"), T0)).toEqual(ist("2026-09-21T10:30:00")));
  it("callback promise: +60 min in hours, 11:00 next working morning out of hours", () => {
    expect(computeCallbackDue(ist("2026-09-16T11:00:00"), T0)).toEqual(ist("2026-09-16T12:00:00"));
    expect(computeCallbackDue(ist("2026-09-09T22:47:00"), T0)).toEqual(ist("2026-09-10T11:00:00"));
  });
  it("working time is IST, not server time", () => {
    expect(isWorkingTime(new Date("2026-09-16T04:30:00Z"), T0.hours, T0.workingDays)).toBe(true); // 10:00 IST
    expect(isWorkingTime(new Date("2026-09-16T13:30:00Z"), T0.hours, T0.workingDays)).toBe(false); // 19:00 IST
  });
  it("quiet hours cross midnight", () => {
    const q = { start: "21:00", end: "08:00" };
    expect(inQuietHours(ist("2026-09-16T21:00:00"), q)).toBe(true);
    expect(inQuietHours(ist("2026-09-16T03:00:00"), q)).toBe(true);
    expect(inQuietHours(ist("2026-09-16T08:00:00"), q)).toBe(false);
    expect(inQuietHours(ist("2026-09-16T20:59:00"), q)).toBe(false);
    expect(afterQuietHours(ist("2026-09-16T23:30:00"), q)).toEqual(ist("2026-09-17T08:00:00"));
    expect(afterQuietHours(ist("2026-09-16T03:30:00"), q)).toEqual(ist("2026-09-16T08:00:00"));
  });
  it("nextOccurrence is strictly after", () => expect(nextOccurrence(ist("2026-09-16T10:30:00"), "10:30")).toEqual(ist("2026-09-17T10:30:00")));
  it("formats in IST", () => {
    expect(fmtTime(ist("2026-09-16T12:19:00"))).toBe("12:19 pm");
    expect(fmtWhen(ist("2026-09-17T10:30:00"), ist("2026-09-16T12:00:00"))).toMatch(/Thu, 17 Sept?, 10:30 am|Thu 17 Sept?, 10:30 am|Thu, 17 Sep.*10:30 am/);
  });
});

const D = (o: Partial<DesignerRow> & { id: string }): DesignerRow => ({ name: o.id, active: true, specialisation: "both", areas_served: [], telegram_chat_id: "x", ...o });

describe("designer picking", () => {
  it("matches type and area, then fewest open leads; ties by name", () => {
    const ds = [D({ id: "home-baner", specialisation: "home", areas_served: ["Baner"] }), D({ id: "office-baner", specialisation: "office", areas_served: ["Baner"] }), D({ id: "home-wakad", specialisation: "home", areas_served: ["Wakad"] }), D({ id: "both-all" })];
    expect(pickDesigner(ds, { "both-all": 3 }, { project_type: "home", location: "Dahanukar Colony, Baner" })?.id).toBe("home-baner");
    expect(pickDesigner(ds, { "home-baner": 2 }, { project_type: "home", location: "Baner" })?.id).toBe("both-all" < "home-baner" ? "both-all" : "home-baner");
    expect(pickDesigner(ds, {}, { project_type: "office", location: "Baner" })?.id).toBe("both-all");
  });
  it("skips inactive and excluded designers; null when nobody fits", () => {
    const ds = [D({ id: "a", active: false }), D({ id: "b" })];
    expect(pickDesigner(ds, {}, { project_type: "home", location: null })?.id).toBe("b");
    expect(pickDesigner(ds, {}, { project_type: "home", location: null }, ["b"])).toBeNull();
  });
  it("area names match as whole words", () => {
    expect(servesArea(["Pune"], "Pimple Saudagar")).toBe(false);
    expect(servesArea(["Pimple Saudagar"], "Pimple Saudagar, Pune")).toBe(true);
    expect(servesArea(["Aundh"], null)).toBe(true);
  });
});

describe("templates never carry a price", () => {
  const ctx = (note: string): T.Ctx => ({
    now: ist("2026-09-16T12:19:00"), baseUrl: "https://app.test", callerPhone: "+919876543210", designerName: "Anaya",
    lead: { id: "L1", caller_name: "Priya", project_type: "home", location: "Baner", carpet_area_sqft: 1100, bhk_or_rooms: "3BHK", budget_range: null, timeline: null, possession_status: "ready", classification: "qualified", handoff_note: note, missing_info: [], review_reason: null, sla_due_at: ist("2026-09-16T12:49:00").toISOString(), callback_due_at: null },
  });
  it("caller SMS and reminders contain no figures", () => {
    const c = ctx("note");
    for (const t of [T.callerSms(c), T.reminder(c).text, T.slaBreach(c).text, T.callReminder(c).text, T.newEnquiry(c).text]) expect(hasPriceLeak(t)).toBe(false);
  });
  it("escapes HTML in caller-supplied text", () => {
    expect(T.leadAssigned(ctx("<b>x</b> & y")).text).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});

describe("HubSpot", () => {
  function mockFetch(contactExists: boolean) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ method: init.method!, path, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (path.endsWith("/contacts/search")) return new Response(JSON.stringify({ results: contactExists ? [{ id: "C9" }] : [] }));
      if (init.method === "POST" && path.endsWith("/contacts")) return new Response(JSON.stringify({ id: "C1" }));
      if (init.method === "POST" && path.endsWith("/deals")) return new Response(JSON.stringify({ id: "D1" }));
      if (init.method === "POST" && path.endsWith("/notes")) return new Response(JSON.stringify({ id: "N1" }));
      return new Response("{}");
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const cfg = (f: typeof fetch) => hubspotClient({ token: "tok", pipeline: "default", stageMap: { new: "s_new", accepted: "s_acc" }, f });
  const payload = { lead_id: "L1", caller_name: "Priya Shah", phone: "+919876543210", project_type: "home", location: "Baner", classification: "qualified", status: "new", handoff_note: "Full redesign.", owner_id: "77", want_deal: true };

  it("creates contact, deal (owner + stage), association and note", async () => {
    const { f, calls } = mockFetch(false);
    const r = await cfg(f).sync(payload);
    expect(r).toEqual({ contact_id: "C1", deal_id: "D1" });
    const seq = calls.map((c) => `${c.method} ${c.path}`);
    expect(seq).toEqual([
      "POST /crm/v3/objects/contacts/search", "POST /crm/v3/objects/contacts", "POST /crm/v3/objects/deals",
      "PUT /crm/v4/objects/deals/D1/associations/default/contacts/C1", "POST /crm/v3/objects/notes", "PUT /crm/v4/objects/notes/N1/associations/default/deals/D1",
    ]);
    expect(calls[2].body).toEqual({ properties: { dealname: "Priya Shah · Home · Baner", pipeline: "default", dealstage: "s_new", hubspot_owner_id: "77" } });
    expect(calls[1].body).toMatchObject({ properties: { firstname: "Priya", lastname: "Shah", phone: "+919876543210" } });
  });
  it("reuses an existing contact found by phone and sends the bearer token", async () => {
    const { f, calls } = mockFetch(true);
    const r = await cfg(f).sync({ ...payload, want_deal: false });
    expect(r).toEqual({ contact_id: "C9" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers.authorization).toBe("Bearer tok");
  });
  it("is idempotent once ids are known: updates stage, creates nothing", async () => {
    const { f, calls } = mockFetch(false);
    await cfg(f).sync({ ...payload, status: "accepted", contact_id: "C1", deal_id: "D1" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /crm/v3/objects/contacts/C1", "PATCH /crm/v3/objects/deals/D1"]);
    expect((calls[1].body as { properties: { dealstage: string } }).properties.dealstage).toBe("s_acc");
  });

  const lead = (o: Record<string, unknown>) => ({ id: "L1", call_id: "c1", call_type: "new_enquiry", status: "new", classification: "qualified", caller_name: "Priya", project_type: "home", location: "Baner", handoff_note: "Fine.", hubspot_sync_status: "pending", assigned_designer_id: null, ...o });
  const run = async (l: Record<string, unknown>, phone = "+919876543210", f?: typeof fetch) => {
    const { db, tables } = fakeDb({ leads: [lead(l)], calls: [{ id: "c1", caller_phone: phone }], designers: [] });
    const m = mockFetch(false);
    const status = await syncLead(db, cfg(f ?? m.f), "L1");
    return { status, lead: tables.leads[0], calls: m.calls };
  };
  it("qualified lead -> contact + deal recorded on the lead", async () => {
    const r = await run({});
    expect(r.status).toBe("synced");
    expect(r.lead).toMatchObject({ hubspot_contact_id: "C1", hubspot_deal_id: "D1", hubspot_sync_status: "synced" });
  });
  it("not qualified / in review -> contact only, no deal", async () => {
    const r = await run({ classification: "not_qualified", status: "in_review" });
    expect(r.lead).toMatchObject({ hubspot_contact_id: "C1", hubspot_deal_id: null });
    expect(r.calls.some((c) => c.path.includes("/deals"))).toBe(false);
  });
  it("existing-client complaints never become deals", async () => {
    const r = await run({ call_type: "existing_client", status: "in_review", classification: "borderline" });
    expect(r.calls.some((c) => c.path.includes("/deals"))).toBe(false);
  });
  it("a price in the note is never sent to HubSpot", async () => {
    const r = await run({ handoff_note: "Budget is 12 lakh" });
    expect(r.calls.some((c) => c.path.endsWith("/notes"))).toBe(false);
  });
  it("unknown phone -> skipped; HubSpot errors are recorded, never thrown", async () => {
    expect((await run({}, "unknown")).status).toBe("skipped");
    const boom = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const r = await run({}, "+919876543210", boom);
    expect(r.status).toBe("failed");
    expect(r.lead).toMatchObject({ hubspot_sync_status: "failed" });
    expect(String(r.lead.hubspot_sync_error)).toContain("429");
  });
});

import { suggestStageMap } from "@/lib/crm/stages";
describe("HubSpot stage mapping from a real pipeline", () => {
  const stage = (id: string, order: number, closed = "false", probability = "0.2") => ({ id, label: id, displayOrder: order, metadata: { isClosed: closed, probability } });
  it("maps open stages in order and closed stages by probability", () => {
    const m = suggestStageMap([stage("lost", 6, "true", "0.0"), stage("a", 0), stage("b", 1), stage("c", 2), stage("d", 3), stage("won", 5, "true", "1.0")]);
    expect(m).toMatchObject({ new: "a", sent_to_designer: "a", in_review: "a", accepted: "b", contacted: "c", won: "won", lost: "lost", closed: "lost" });
  });
  it("reuses the last open stage when the pipeline is short, and refuses a pipeline with no won/lost", () => {
    const m = suggestStageMap([stage("only", 0), stage("w", 1, "true", "1.0"), stage("l", 2, "true", "0.0")]);
    expect(m.accepted).toBe("only");
    expect(m.contacted).toBe("only");
    expect(() => suggestStageMap([stage("only", 0)])).toThrow(/closed-won/);
  });
});
