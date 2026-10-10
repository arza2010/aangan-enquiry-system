import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runPostCall, type PostCallResult } from "@/lib/ai/postCall";
import { loadSettings } from "@/lib/settings";
import { logCost, llmCostInr } from "@/lib/costs";

/**
 * Step 2: run the post-call LLM for a stored call and write the lead.
 * Idempotent (leads.call_id is unique) so cron can safely retry calls that have no lead yet.
 * Whatever happens, a lead row exists afterwards: on failure it is `needs_review`, never dropped.
 */
export async function analyseCall(
  db: SupabaseClient,
  callId: string,
  run: typeof runPostCall = runPostCall,
): Promise<{ leadId: string; classification: string | null; needsReview: boolean }> {
  const already = await db.from("leads").select("id, classification, needs_review").eq("call_id", callId).maybeSingle();
  if (already.data) return { leadId: already.data.id, classification: already.data.classification, needsReview: already.data.needs_review };

  const { data: call, error } = await db.from("calls").select("*").eq("id", callId).single();
  if (error || !call) throw new Error(`call ${callId} not found`);

  let result: PostCallResult | null = null;
  let apiError: string | null = null;
  const noConversation = String(call.transcript ?? "").replace(/\s+/g, " ").trim().length < 20;
  try {
    // A call that ended before anyone spoke has nothing to classify: do not spend an LLM call or invent details.
    if (!noConversation) result = await run({ transcript: call.transcript, startedAt: call.started_at });
  } catch (e) {
    apiError = e instanceof Error ? e.message : String(e);
  }

  if (result) {
    const settings = await loadSettings(db);
    await logCost(db, {
      call_id: callId,
      service: "llm",
      units: result.usage.input_tokens + result.usage.output_tokens,
      unit_type: "tokens",
      cost_inr: llmCostInr(result.usage, settings),
      detail: result.model,
    });
  }

  let row: Record<string, unknown>;
  if (result?.ok) {
    const d = result.data;
    const reasons: string[] = [];
    if (d.price_mentioned_in_call) reasons.push("price mentioned in call");
    if (d.call_type !== "new_enquiry") reasons.push(`call type: ${d.call_type}`);
    if (result.flags.includes("handoff_note_redacted")) reasons.push("handoff note had price figures (redacted)");
    if (call.caller_phone === "unknown") reasons.push("caller number unknown: cannot SMS or call back until found");
    if (d.classification !== "qualified") reasons.push(`${d.classification.replace("_", " ")}: ${d.classification_reason}`);

    row = {
      call_id: callId,
      call_type: d.call_type,
      // Qualified goes straight on to routing (step 4); everything else waits for the front desk.
      status: d.classification === "qualified" && reasons.length === 0 ? "new" : "in_review",
      caller_name: d.caller_name,
      project_type: d.project_type,
      location: d.location,
      carpet_area_sqft: d.carpet_area_sqft,
      bhk_or_rooms: d.bhk_or_rooms,
      scope: d.scope,
      budget_range: d.budget_range,
      timeline: d.timeline,
      possession_status: d.possession_status,
      source: d.source,
      language: d.language,
      classification: d.classification,
      classification_reason: d.classification_reason,
      missing_info: d.missing_info,
      handoff_note: d.handoff_note,
      price_mentioned_in_call: d.price_mentioned_in_call,
      needs_review: reasons.length > 0,
      review_reason: reasons.length ? reasons.join("; ") : null,
    };
  } else {
    row = {
      call_id: callId,
      status: "in_review",
      needs_review: true,
      review_reason: noConversation
        ? "no conversation captured (the call ended before the caller was heard): follow up by phone if a number is known"
        : `extraction failed: ${apiError ?? (result && !result.ok ? result.error : "unknown")}`,
    };
  }

  const ins = await db.from("leads").insert(row).select("id, classification, needs_review").single();
  if (ins.error) throw new Error(`lead insert failed: ${ins.error.message}`);

  // Link any booking Vaani made mid-call (keyed on Vaani's call id) to this call + lead.
  await db.from("bookings").update({ call_id: callId, lead_id: ins.data.id }).eq("vaani_call_id", call.external_id).is("lead_id", null);

  return { leadId: ins.data.id, classification: ins.data.classification, needsReview: ins.data.needs_review };
}
