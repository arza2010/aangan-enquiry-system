import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Deps } from "./deps";
import { pickDesigner, type DesignerRow } from "./routing";
import { loadSettings } from "./settings";
import { cancelPending, enqueue } from "./notify/queue";
import { frontDeskChat, isAuthorised } from "./notify/recipients";
import { assignAndNotify } from "./pipeline/assign";
import { openLeadCounts } from "./pipeline/route";

export type ActionResult = { ok: boolean; message: string; designerName?: string };

async function loadLead(db: SupabaseClient, leadId: string) {
  const { data: lead } = await db.from("leads").select("*").eq("id", leadId).single();
  const designer = lead?.assigned_designer_id ? (await db.from("designers").select("*").eq("id", lead.assigned_designer_id).single()).data : null;
  return { lead, designer };
}

/** Designer taps Accept in Telegram. */
export async function acceptLead(db: SupabaseClient, deps: Deps, leadId: string, actorChatId: string): Promise<ActionResult> {
  const { lead, designer } = await loadLead(db, leadId);
  if (!lead) return { ok: false, message: "Lead not found" };
  if (!isAuthorised(actorChatId, designer?.telegram_chat_id ?? null)) return { ok: false, message: "This lead is not assigned to you" };
  if (lead.accepted_at) return { ok: true, message: "Already accepted", designerName: designer?.name };

  const now = deps.now();
  await db.from("leads").update({ status: "accepted", accepted_at: now.toISOString(), hubspot_sync_status: "pending" }).eq("id", leadId);
  // Stops the 10-min nudge and the SLA escalation; stamps the alert so the dashboard can show alert-to-accept time.
  await cancelPending(db, leadId, ["reminder", "sla_breach"], now, "accepted");
  await db.from("notifications").update({ acted_at: now.toISOString() }).eq("lead_id", leadId).eq("type", "lead_assigned").is("acted_at", null);
  return { ok: true, message: "Accepted", designerName: designer?.name };
}

/** Designer (or front desk / Nikhil from an overdue alert) taps Reassign. */
export async function reassignLead(db: SupabaseClient, deps: Deps, leadId: string, actorChatId: string): Promise<ActionResult> {
  const { lead, designer } = await loadLead(db, leadId);
  if (!lead) return { ok: false, message: "Lead not found" };
  if (!isAuthorised(actorChatId, designer?.telegram_chat_id ?? null)) return { ok: false, message: "This lead is not assigned to you" };
  if (lead.call_type !== "new_enquiry") return { ok: false, message: "Only new enquiries can be reassigned" };

  const now = deps.now();
  const settings = await loadSettings(db);
  const { data: designers } = await db.from("designers").select("*").eq("active", true);
  const next = pickDesigner((designers ?? []) as DesignerRow[], await openLeadCounts(db), lead, lead.assigned_designer_id ? [lead.assigned_designer_id] : []);

  if (!next) {
    await enqueue(db, {
      lead_id: leadId, recipient_type: "front_desk", chat_id: frontDeskChat(), type: "needs_review",
      scheduled_for: now, dedupe_key: `no_designer_for_reassign:${leadId}:${now.getTime()}`,
    });
    await db.from("leads").update({ review_reason: "reassign requested but no other designer matches" }).eq("id", leadId);
    return { ok: false, message: "No other designer matches: front desk notified" };
  }

  await cancelPending(db, leadId, ["lead_assigned", "reminder", "sla_breach", "call_reminder"], now, "reassigned");
  const { data: bookings } = await db.from("bookings").select("*").eq("lead_id", leadId).in("status", ["provisional", "confirmed"]);
  await assignAndNotify(db, {
    leadId, designer: next as DesignerRow & { night_alerts: boolean }, booking: bookings?.[0] ?? null, settings, now, round: String(now.getTime()),
  });
  return { ok: true, message: `Reassigned to ${next.name}`, designerName: next.name };
}
