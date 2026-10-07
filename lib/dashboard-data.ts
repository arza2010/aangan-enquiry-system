import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetricRows } from "./metrics";
import type { Period } from "./range";

/** Rows for one period. Uses the signed-in staff member's client, so RLS applies. */
export async function loadPeriod(sb: SupabaseClient, p: Period, settings: Record<string, unknown>): Promise<MetricRows> {
  const from = p.from.toISOString();
  const to = p.to.toISOString();
  const { data: calls } = await sb.from("calls").select("id, started_at, ended_at, after_hours, repeat_caller").gte("started_at", from).lt("started_at", to).limit(5000);
  const { data: leads } = await sb.from("leads").select("*").gte("created_at", from).lt("created_at", to).limit(5000);
  const ids = (leads ?? []).map((l) => l.id as string);
  const chunks = <T,>(xs: T[], n = 150) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  const notifications: Record<string, unknown>[] = [];
  const bookings: Record<string, unknown>[] = [];
  for (const c of chunks(ids)) {
    notifications.push(...((await sb.from("notifications").select("lead_id, type, recipient_type, sent_at, acted_at").in("lead_id", c).in("type", ["new_enquiry", "lead_assigned"])).data ?? []));
    bookings.push(...((await sb.from("bookings").select("lead_id, status").in("lead_id", c)).data ?? []));
  }
  const { data: costs } = await sb.from("cost_events").select("call_id, service, cost_inr, created_at").gte("created_at", from).lt("created_at", to).limit(20000);
  return { calls: calls ?? [], leads: leads ?? [], bookings, notifications, costs: costs ?? [], settings, days: p.days };
}
