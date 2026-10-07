import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Deps } from "@/lib/deps";
import { pickDesigner, type DesignerRow } from "@/lib/routing";
import { loadSettings, timingFrom } from "@/lib/settings";
import { computeCallbackDue } from "@/lib/time";
import { enqueue } from "@/lib/notify/queue";
import { frontDeskChat, nikhilChat } from "@/lib/notify/recipients";
import { assignAndNotify } from "./assign";
import { linkBookingToCall } from "@/lib/booking/service";

export const OPEN_STATUSES = ["sent_to_designer", "accepted", "in_review", "contacted"];

export async function openLeadCounts(db: SupabaseClient): Promise<Record<string, number>> {
  const { data } = await db.from("leads").select("assigned_designer_id, status").in("status", OPEN_STATUSES);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) if (r.assigned_designer_id) counts[r.assigned_designer_id] = (counts[r.assigned_designer_id] ?? 0) + 1;
  return counts;
}

/**
 * Step 3 of the pipeline: decide who sees this lead and queue the alerts (brief §5, §8A).
 * - clean qualified lead   -> designer (the booked designer if there is a booking, else fewest open leads)
 * - everything else        -> front desk review queue (nobody is dropped)
 * - existing client        -> Nikhil + front desk, never a designer
 * Idempotent: guarded by leads.routed_at and notification dedupe keys.
 */
export async function routeLead(db: SupabaseClient, deps: Deps, leadId: string) {
  const { data: lead } = await db.from("leads").select("*").eq("id", leadId).single();
  if (!lead) throw new Error(`lead ${leadId} not found`);
  if (lead.routed_at) return { routed: false as const, reason: "already routed" };

  const { data: call } = await db.from("calls").select("*").eq("id", lead.call_id).single();
  const settings = await loadSettings(db);
  const now = deps.now();
  const phoneKnown = call?.caller_phone && call.caller_phone !== "unknown";

  const { data: bookings } = await db.from("bookings").select("*").eq("lead_id", leadId).in("status", ["provisional", "confirmed"]);
  let booking = bookings?.[0] ?? null;
  if (!booking && deps.booking && call) {
    // Vaani booked straight into Cal.com during the call; find that booking. A scheduler outage must not stop routing.
    try {
      booking = await linkBookingToCall(db, deps.booking, call, leadId);
    } catch (e) {
      console.error("link booking failed", leadId, e instanceof Error ? e.message : e);
    }
  }

  let designer: (DesignerRow & { night_alerts: boolean }) | null = null;
  let outcome: "assigned" | "review" | "escalated" = "review";

  if (lead.call_type === "existing_client") {
    outcome = "escalated";
  } else if (lead.status === "new" && lead.call_type === "new_enquiry") {
    const { data: designers } = await db.from("designers").select("*").eq("active", true);
    const list = (designers ?? []) as (DesignerRow & { night_alerts: boolean })[];
    designer = (booking && list.find((d) => d.id === booking.designer_id)) || pickDesigner(list, await openLeadCounts(db), lead);
    if (designer) {
      await assignAndNotify(db, { leadId, designer, booking, settings, now });
      outcome = "assigned";
    } else {
      // Brief §11: no active designer -> front desk alert.
      await db.from("leads").update({ status: "in_review", needs_review: true, review_reason: "no active designer matches this project type and area" }).eq("id", leadId);
      lead.review_reason = "no active designer matches this project type and area";
      lead.status = "in_review";
    }
  }

  if (outcome !== "assigned") {
    const t = timingFrom(settings);
    await db.from("leads").update({ callback_due_at: lead.callback_due_at ?? computeCallbackDue(now, t).toISOString() }).eq("id", leadId);
  }

  const fresh = (await db.from("leads").select("*").eq("id", leadId).single()).data ?? lead;
  const payload = { designer_id: designer?.id ?? null };

  // Every new enquiry: front desk group, seconds after the call.
  await enqueue(db, { lead_id: leadId, recipient_type: "front_desk", chat_id: frontDeskChat(), type: "new_enquiry", payload, scheduled_for: now, dedupe_key: `new_enquiry:${leadId}` });

  if (outcome === "review") {
    await enqueue(db, { lead_id: leadId, recipient_type: "front_desk", chat_id: frontDeskChat(), type: "needs_review", scheduled_for: now, dedupe_key: `needs_review:${leadId}` });
  }
  if (outcome === "escalated") {
    for (const [who, chat] of [["nikhil", nikhilChat()], ["front_desk", frontDeskChat()]] as const) {
      await enqueue(db, { lead_id: leadId, recipient_type: who, chat_id: chat, type: "escalation", scheduled_for: now, dedupe_key: `escalation:${leadId}:${who}` });
    }
  }

  // Caller always gets confirmation that the enquiry was received (except complaints / non-enquiries).
  if (lead.call_type === "new_enquiry" && phoneKnown) {
    await enqueue(db, { lead_id: leadId, recipient_type: "caller", chat_id: call!.caller_phone, channel: "sms", type: "caller_sms", scheduled_for: now, dedupe_key: `caller_sms:${leadId}` });
  }

  await db.from("leads").update({ routed_at: now.toISOString() }).eq("id", fresh.id);
  return { routed: true as const, outcome, designerId: designer?.id ?? null };
}
