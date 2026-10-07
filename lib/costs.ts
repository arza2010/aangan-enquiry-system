import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { num, type SettingsMap } from "./settings";

type Service = "vaani" | "llm" | "sms" | "telegram";

/** Hard rule #5: every external call logs its cost. Unit prices live in `settings`, so they can be corrected later. */
export async function logCost(
  db: SupabaseClient,
  e: { call_id: string | null; service: Service; units: number; unit_type: string; cost_inr: number; detail?: string },
) {
  const { error } = await db.from("cost_events").insert(e);
  if (error) console.error("cost_events insert failed", error.message); // never block the pipeline on bookkeeping
}

export const vaaniCreditsCostInr = (credits: number, s: SettingsMap) => credits * num(s, "price_vaani_inr_per_credit");

/** Fallback when Vaani's own credit figure is unavailable. */
export const vaaniCostInr = (durationSec: number, s: SettingsMap) =>
  (durationSec / 60) * num(s, "price_vaani_inr_per_min");

export const llmCostInr = (u: { input_tokens: number; output_tokens: number }, s: SettingsMap) =>
  (u.input_tokens / 1e6) * num(s, "price_llm_inr_per_m_input") +
  (u.output_tokens / 1e6) * num(s, "price_llm_inr_per_m_output");
