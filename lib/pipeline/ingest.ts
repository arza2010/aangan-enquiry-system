import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalisedEnquiry } from "@/lib/channels/types";
import { isAfterHours } from "@/lib/hours";
import { loadSettings } from "@/lib/settings";
import { logCost, vaaniCostInr, vaaniCreditsCostInr } from "@/lib/costs";
import { UNKNOWN_PHONE } from "@/lib/channels/vaani";

export type IngestResult = { callId: string; duplicate: boolean };

/**
 * Step 1 of the pipeline, kept small and synchronous so the webhook can acknowledge fast:
 * dedupe on (channel, external_id), flag repeat callers, store the call, log provider cost.
 * Everything after this (LLM, routing, alerts) can fail without losing the call.
 */
export async function ingestCall(db: SupabaseClient, n: NormalisedEnquiry): Promise<IngestResult> {
  const existing = await db.from("calls").select("id").eq("channel", n.channel).eq("external_id", n.external_id).maybeSingle();
  if (existing.data) return { callId: existing.data.id, duplicate: true };

  const settings = await loadSettings(db);
  const hours = (settings.working_hours as { start: string; end: string } | undefined) ?? undefined;

  const prior =
    n.caller_phone === UNKNOWN_PHONE
      ? { count: 0 }
      : await db
          .from("calls")
          .select("id", { count: "exact", head: true })
          .eq("caller_phone", n.caller_phone)
          .lt("started_at", n.started_at);

  const { data, error } = await db
    .from("calls")
    .insert({
      channel: n.channel,
      external_id: n.external_id,
      caller_phone: n.caller_phone,
      started_at: n.started_at,
      ended_at: n.ended_at,
      duration_sec: n.duration_sec,
      transcript: n.transcript,
      language: n.language,
      recording_url: n.recording_url ?? null,
      repeat_caller: (prior.count ?? 0) > 0,
      after_hours: isAfterHours(new Date(n.started_at), hours),
      raw: n.raw as object,
    })
    .select("id")
    .single();

  if (error) {
    // Lost a race with a retry of the same webhook: treat as duplicate.
    if (error.code === "23505") {
      const again = await db.from("calls").select("id").eq("channel", n.channel).eq("external_id", n.external_id).single();
      if (again.data) return { callId: again.data.id, duplicate: true };
    }
    throw new Error(`calls insert failed: ${error.message}`);
  }

  if (n.provider_cost_credits != null) {
    await logCost(db, {
      call_id: data.id,
      service: "vaani",
      units: n.provider_cost_credits,
      unit_type: "credits",
      cost_inr: vaaniCreditsCostInr(n.provider_cost_credits, settings),
    });
  } else if (n.duration_sec != null) {
    await logCost(db, {
      call_id: data.id,
      service: "vaani",
      units: n.duration_sec / 60,
      unit_type: "minutes",
      cost_inr: vaaniCostInr(n.duration_sec, settings),
    });
  }
  return { callId: data.id, duplicate: false };
}
