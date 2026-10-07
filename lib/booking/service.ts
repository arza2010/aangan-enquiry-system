import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingProvider } from "./types";
import { pickSlots } from "./slots";
import { loadSettings, num, timingFrom, type SettingsMap } from "@/lib/settings";
import { addMinutes } from "@/lib/time";

const rules = (s: SettingsMap) => {
  const t = timingFrom(s);
  return { hours: t.hours, workingDays: t.workingDays, minLeadMinutes: num(s, "slot_min_lead_minutes", 30), horizonHours: num(s, "slot_horizon_hours", 48) };
};

/** 2-3 start times to read out to the caller. The slot id IS the ISO start time: the provider re-validates it on booking. */
export async function offerSlots(db: SupabaseClient, provider: BookingProvider, now: Date) {
  const s = await loadSettings(db);
  const r = rules(s);
  const raw = await provider.getSlots(addMinutes(now, r.minLeadMinutes).toISOString(), addMinutes(now, r.horizonHours * 60).toISOString());
  const { data: held } = await db.from("bookings").select("slot_start").in("status", ["provisional", "confirmed"]);
  const heldSet = new Set((held ?? []).map((b) => new Date(b.slot_start as string).toISOString()));
  return pickSlots(raw.filter((x) => !heldSet.has(x)), now, r);
}

export type BookResult =
  | { ok: true; booking: { id: string; slot_start: string; slot_end: string }; duplicate: boolean }
  | { ok: false; reason: "slot_taken" | "provider_error"; message: string };

/**
 * Mid-call booking (called by Vaani's tool). Idempotent: the same call + slot returns the existing booking, so a
 * retried tool call never double-books. Starts `provisional`; a qualified lead confirms it after the call.
 */
export async function bookSlot(
  db: SupabaseClient, provider: BookingProvider,
  a: { vaaniCallId: string; start: string; name: string; phone: string },
): Promise<BookResult> {
  const start = new Date(a.start).toISOString();
  const { data: byCall } = await db.from("bookings").select("*").eq("vaani_call_id", a.vaaniCallId).eq("slot_start", start).in("status", ["provisional", "confirmed"]).maybeSingle();
  // A retried tool call carries a fresh generated call id, so the same caller + slot also counts as "the same booking".
  const { data: byPhone } = byCall ? { data: null } : await db.from("bookings").select("*").eq("caller_phone", a.phone).eq("slot_start", start).in("status", ["provisional", "confirmed"]).maybeSingle();
  const existing = byCall ?? byPhone;
  if (existing) return { ok: true, duplicate: true, booking: { id: existing.id, slot_start: existing.slot_start, slot_end: existing.slot_end } };

  let made: { uid: string; start: string; end: string };
  try {
    made = await provider.book({ start, name: a.name, phone: a.phone, callRef: a.vaaniCallId });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /400|409|unavailable|no longer|not available/i.test(m) ? "slot_taken" : "provider_error", message: m };
  }
  const { data, error } = await db.from("bookings").insert({
    vaani_call_id: a.vaaniCallId, slot_start: made.start, slot_end: made.end, status: "provisional",
    provider: provider.name, provider_booking_uid: made.uid, caller_name: a.name, caller_phone: a.phone,
  }).select("id, slot_start, slot_end").single();
  if (error) {
    await provider.cancel(made.uid, "duplicate").catch(() => {}); // our own double-book guard fired: do not leave an orphan on the calendar
    return { ok: false, reason: "slot_taken", message: error.message };
  }
  return { ok: true, duplicate: false, booking: data as { id: string; slot_start: string; slot_end: string } };
}

/**
 * Vaani's native Cal.com integration books mid-call without telling us. After the call, find the booking made during
 * that call's time window and attach it to the lead. Matches on the caller's phone when several overlap; otherwise
 * only links when exactly one booking falls in the window (never guesses between two callers).
 */
export async function linkBookingToCall(
  db: SupabaseClient, provider: BookingProvider | null,
  call: { id: string; external_id: string; caller_phone: string; started_at: string; ended_at: string | null; duration_sec: number | null },
  leadId: string,
  now: Date = new Date(),
) {
  const { data: have } = await db.from("bookings").select("*").eq("vaani_call_id", call.external_id).in("status", ["provisional", "confirmed"]);
  if (have?.length) {
    await db.from("bookings").update({ call_id: call.id, lead_id: leadId }).eq("vaani_call_id", call.external_id).is("lead_id", null);
    return have[0];
  }
  const start = new Date(call.started_at);
  const end = call.ended_at ? new Date(call.ended_at) : addMinutes(start, Math.ceil((call.duration_sec ?? 300) / 60));

  // 1) A booking our own book_slot tool made mid-call: it is in OUR table, not yet tied to a call or lead.
  // Belt and braces: Vaani's call-history timestamps are undocumented (UTC assumed), so a booking made in the 20 minutes before
  // this webhook arrived also counts. Calls are analysed within a minute of ending, so that is the same call.
  const lo = new Date(Math.min(addMinutes(start, -2).getTime(), addMinutes(now, -20).getTime()));
  const hi = new Date(Math.max(addMinutes(end, 3).getTime(), now.getTime()));
  const inWindow = (iso: string) => { const t = new Date(iso).getTime(); return (t >= addMinutes(start, -2).getTime() && t <= addMinutes(end, 3).getTime()) || (t >= addMinutes(now, -20).getTime() && t <= now.getTime()); };
  const { data: ownAll } = await db.from("bookings").select("*").is("lead_id", null).in("status", ["provisional", "confirmed"]).gte("created_at", lo.toISOString()).lte("created_at", hi.toISOString());
  const own = (ownAll ?? []).filter((b) => inWindow(b.created_at as string));
  const last10 = (p?: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);
  const ownByPhone = (own ?? []).filter((b) => last10(b.caller_phone) && last10(b.caller_phone) === last10(call.caller_phone));
  const ownPick = ownByPhone.length === 1 ? ownByPhone[0] : (own ?? []).length === 1 ? own![0] : null;
  if (ownPick) {
    await db.from("bookings").update({ call_id: call.id, lead_id: leadId, vaani_call_id: call.external_id }).eq("id", ownPick.id);
    return { ...ownPick, call_id: call.id, lead_id: leadId };
  }

  // 2) Otherwise a booking Vaani made natively in Cal.com.
  if (!provider) return null;
  const found = (await provider.listCreatedBetween(addMinutes(start, -2).toISOString(), addMinutes(end, 3).toISOString())).filter((b) => b.status !== "cancelled" && b.status !== "rejected");
  const digits = (p?: string) => (p ?? "").replace(/\D/g, "").slice(-10);
  const byPhone = found.filter((b) => digits(b.attendeePhone) && digits(b.attendeePhone) === digits(call.caller_phone));
  const pick = byPhone.length === 1 ? byPhone[0] : found.length === 1 ? found[0] : null;
  if (!pick) return null;

  const { data, error } = await db.from("bookings").insert({
    vaani_call_id: call.external_id, call_id: call.id, lead_id: leadId, slot_start: pick.start, slot_end: pick.end, status: "provisional",
    provider: provider.name, provider_booking_uid: pick.uid, caller_name: pick.attendeeName ?? null, caller_phone: call.caller_phone,
  }).select("*").single();
  return error ? null : data;
}

/** Front desk "Cancel": drop the consult from the calendar and mark it cancelled. The caller SMS is queued by the caller of this. */
export async function cancelBooking(db: SupabaseClient, provider: BookingProvider | null, bookingId: string, reason: string) {
  const { data: b } = await db.from("bookings").select("*").eq("id", bookingId).single();
  if (!b) return { ok: false as const, message: "booking not found" };
  let providerError: string | null = null;
  if (provider && b.provider_booking_uid) {
    try { await provider.cancel(b.provider_booking_uid as string, reason); } catch (e) { providerError = e instanceof Error ? e.message : String(e); }
  }
  await db.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
  return { ok: true as const, providerError };
}

/** Cron: if the caller cancels or moves a consult from the Cal.com email, mirror that so reminders stay truthful. */
export async function syncBookingStatuses(db: SupabaseClient, provider: BookingProvider, now: Date) {
  const { data: rows } = await db.from("bookings").select("*").in("status", ["provisional", "confirmed"]).gt("slot_start", now.toISOString()).lt("slot_start", addMinutes(now, 72 * 60).toISOString()).limit(20);
  let changed = 0;
  for (const b of rows ?? []) {
    if (!b.provider_booking_uid) continue;
    try {
      const remote = await provider.get(b.provider_booking_uid as string);
      if (!remote || remote.status === "cancelled" || remote.status === "rejected") {
        await db.from("bookings").update({ status: "cancelled" }).eq("id", b.id);
        changed++;
      } else if (remote.start !== new Date(b.slot_start as string).toISOString()) {
        await db.from("bookings").update({ slot_start: remote.start, slot_end: remote.end }).eq("id", b.id);
        changed++;
      }
    } catch (e) {
      console.error("booking status sync failed", b.id, e instanceof Error ? e.message : e);
    }
  }
  return { checked: rows?.length ?? 0, changed };
}
