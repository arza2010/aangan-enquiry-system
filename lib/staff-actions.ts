import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Deps } from "./deps";
import type { DesignerRow } from "./routing";
import { loadSettings } from "./settings";
import { cancelPending, enqueue } from "./notify/queue";
import { assignAndNotify } from "./pipeline/assign";
import { cancelBooking } from "./booking/service";
import { processDue } from "./notify/dispatch";

/**
 * What front desk and Nikhil can do from the web app. Every action marks the lead for a HubSpot re-sync and never throws
 * for "nothing to do" cases: it returns a message the UI can show.
 */
export type StaffResult = { ok: boolean; message: string };

const touch = { hubspot_sync_status: "pending" as const };

export async function sendToDesigner(db: SupabaseClient, deps: Deps, leadId: string, designerId: string): Promise<StaffResult> {
  const { data: lead } = await db.from("leads").select("*").eq("id", leadId).single();
  const { data: designer } = await db.from("designers").select("*").eq("id", designerId).single();
  if (!lead || !designer) return { ok: false, message: "Lead or designer not found" };
  if (!designer.active) return { ok: false, message: `${designer.name} is not active` };
  const settings = await loadSettings(db);
  const { data: bookings } = await db.from("bookings").select("*").eq("lead_id", leadId).in("status", ["provisional", "confirmed"]);
  const now = deps.now();
  await cancelPending(db, leadId, ["lead_assigned", "reminder", "sla_breach", "call_reminder"], now, "reassigned by front desk");
  await assignAndNotify(db, { leadId, designer: designer as DesignerRow & { night_alerts: boolean }, booking: bookings?.[0] ?? null, settings, now, round: `manual-${now.getTime()}` });
  await db.from("leads").update({ needs_review: false, review_reason: null }).eq("id", leadId);
  await processDue(db, deps); // the designer is alerted straight away
  return { ok: true, message: `Sent to ${designer.name}` };
}

export async function markContacted(db: SupabaseClient, deps: Deps, leadId: string): Promise<StaffResult> {
  const now = deps.now();
  const { data: lead } = await db.from("leads").select("first_response_at").eq("id", leadId).single();
  if (!lead) return { ok: false, message: "Lead not found" };
  await db.from("leads").update({ status: "contacted", first_response_at: lead.first_response_at ?? now.toISOString(), needs_review: false, ...touch }).eq("id", leadId);
  await cancelPending(db, leadId, ["reminder", "sla_breach"], now, "contacted");
  return { ok: true, message: "Marked contacted" };
}

export async function closeLead(db: SupabaseClient, deps: Deps, leadId: string): Promise<StaffResult> {
  await db.from("leads").update({ status: "closed", needs_review: false, ...touch }).eq("id", leadId);
  await cancelPending(db, leadId, ["reminder", "sla_breach", "call_reminder"], deps.now(), "closed");
  return { ok: true, message: "Closed" };
}

export async function setOutcome(db: SupabaseClient, deps: Deps, leadId: string, outcome: "won" | "lost"): Promise<StaffResult> {
  await db.from("leads").update({ status: outcome, outcome_at: deps.now().toISOString(), needs_review: false, ...touch }).eq("id", leadId);
  await cancelPending(db, leadId, ["reminder", "sla_breach"], deps.now(), outcome);
  return { ok: true, message: `Marked ${outcome}` };
}

/** "Keep" on a held consult: it becomes a confirmed booking. */
export async function keepBooking(db: SupabaseClient, bookingId: string): Promise<StaffResult> {
  const { data } = await db.from("bookings").update({ status: "confirmed" }).eq("id", bookingId).eq("status", "provisional").select("id");
  return data?.length ? { ok: true, message: "Consult kept" } : { ok: false, message: "Booking is not on hold" };
}

/** "Cancel": delete the Cal.com booking, mark it cancelled, queue the polite SMS. */
export async function cancelHeldBooking(db: SupabaseClient, deps: Deps, bookingId: string): Promise<StaffResult> {
  const { data: b } = await db.from("bookings").select("*").eq("id", bookingId).single();
  if (!b) return { ok: false, message: "Booking not found" };
  if (b.status === "cancelled") return { ok: false, message: "Already cancelled" };
  const r = await cancelBooking(db, deps.booking ?? null, bookingId, "Cancelled by the Aangan front desk");
  if (!r.ok) return { ok: false, message: r.message };
  if (b.lead_id && b.caller_phone && b.caller_phone !== "unknown") {
    await enqueue(db, { lead_id: b.lead_id, recipient_type: "caller", chat_id: b.caller_phone, channel: "sms", type: "booking_cancelled", scheduled_for: deps.now(), dedupe_key: `booking_cancelled:${bookingId}` });
    await processDue(db, deps);
  }
  await cancelPending(db, b.lead_id ?? "", ["call_reminder"], deps.now(), "booking cancelled");
  return { ok: true, message: r.providerError ? `Cancelled here; Cal.com said: ${r.providerError}` : "Consult cancelled and the caller has been messaged" };
}

export async function markConsult(db: SupabaseClient, bookingId: string, result: "completed" | "no_show"): Promise<StaffResult> {
  await db.from("bookings").update({ status: result }).eq("id", bookingId);
  return { ok: true, message: result === "completed" ? "Consult marked completed" : "Marked no-show" };
}
