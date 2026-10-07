import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Deps } from "@/lib/deps";
import { analyseCall } from "./analyse";
import { routeLead } from "./route";
import { processDue } from "@/lib/notify/dispatch";

/** analyse -> route -> send what is due now (so the front desk sees it seconds after the call). */
export async function processCall(db: SupabaseClient, deps: Deps, callId: string) {
  const { leadId } = await analyseCall(db, callId);
  const routed = await routeLead(db, deps, leadId);
  const sent = await processDue(db, deps);
  return { leadId, routed, sent };
}
