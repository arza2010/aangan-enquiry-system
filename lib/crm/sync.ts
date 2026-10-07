import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrmClient } from "./types";
import { hasPriceLeak } from "@/lib/ai/priceGuard";

const DEAL_STATUSES = ["sent_to_designer", "accepted", "contacted", "won", "lost"];

/**
 * Push one lead to the CRM. Contact for every identifiable caller (no call is dropped);
 * a Deal once the lead is real (qualified, or a designer has it). Never throws: failures are recorded on the lead
 * and retried by cron, so HubSpot can never block logging, routing or alerts.
 */
export async function syncLead(db: SupabaseClient, crm: CrmClient, leadId: string): Promise<"synced" | "skipped" | "failed"> {
  const { data: lead } = await db.from("leads").select("*").eq("id", leadId).single();
  if (!lead) return "failed";
  const { data: call } = await db.from("calls").select("caller_phone").eq("id", lead.call_id).single();
  const mark = (patch: Record<string, unknown>) => db.from("leads").update(patch).eq("id", leadId);

  if (!call || call.caller_phone === "unknown") {
    await mark({ hubspot_sync_status: "skipped", hubspot_sync_error: "caller number unknown" });
    return "skipped";
  }
  try {
    const owner = lead.assigned_designer_id
      ? (await db.from("designers").select("hubspot_owner_id").eq("id", lead.assigned_designer_id).single()).data?.hubspot_owner_id ?? null
      : null;
    const note = lead.handoff_note && !hasPriceLeak(lead.handoff_note) ? lead.handoff_note : null; // belt and braces: never sync a price
    const res = await crm.sync({
      lead_id: lead.id,
      caller_name: lead.caller_name,
      phone: call.caller_phone,
      project_type: lead.project_type,
      location: lead.location,
      classification: lead.classification,
      status: lead.status,
      handoff_note: note,
      owner_id: owner,
      want_deal: lead.call_type === "new_enquiry" && (lead.classification === "qualified" || DEAL_STATUSES.includes(lead.status)) && lead.status !== "in_review",
      contact_id: lead.hubspot_contact_id,
      deal_id: lead.hubspot_deal_id,
    });
    await mark({
      hubspot_contact_id: res.contact_id,
      hubspot_deal_id: res.deal_id ?? lead.hubspot_deal_id ?? null,
      hubspot_sync_status: "synced",
      hubspot_synced_at: new Date().toISOString(),
      hubspot_sync_error: null,
    });
    return "synced";
  } catch (e) {
    await mark({ hubspot_sync_status: "failed", hubspot_sync_error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    return "failed";
  }
}

/** Cron: sync leads marked pending, and retry failures that are at least 5 minutes old. */
export async function syncPending(db: SupabaseClient, crm: CrmClient, now: Date, limit = 10) {
  const { data: pending } = await db.from("leads").select("id").eq("hubspot_sync_status", "pending").limit(limit);
  const { data: failed } = await db.from("leads").select("id").eq("hubspot_sync_status", "failed").lt("updated_at", new Date(now.getTime() - 5 * 60_000).toISOString()).limit(limit);
  const ids = [...(pending ?? []), ...(failed ?? [])].slice(0, limit).map((r) => r.id as string);
  const out = { synced: 0, skipped: 0, failed: 0 };
  for (const id of ids) out[await syncLead(db, crm, id)]++;
  return out;
}
