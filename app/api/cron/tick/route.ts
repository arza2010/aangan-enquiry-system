import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildDeps } from "@/lib/deps";
import { processCall } from "@/lib/pipeline/process";
import { routeLead } from "@/lib/pipeline/route";
import { processDue } from "@/lib/notify/dispatch";
import { syncPending } from "@/lib/crm/sync";
import { syncBookingStatuses } from "@/lib/booking/service";

export const maxDuration = 60;

/**
 * Runs every minute (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). Safe to overlap or repeat:
 * everything it does is idempotent. It is also the safety net that makes sure no call is lost:
 *   1. calls that never got a lead (analysis crashed)   -> analyse + route
 *   2. leads that were analysed but never routed         -> route
 *   3. due notifications (alerts, reminders, escalations, digest)
 *   4. HubSpot sync (pending + retry failed)
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const deps = await buildDeps(db);
  const now = deps.now();
  const out: Record<string, unknown> = {};

  // Only look at calls older than 2 minutes so we never race the webhook that is still processing them.
  const cutoff = new Date(now.getTime() - 2 * 60_000).toISOString();
  const since = new Date(now.getTime() - 3 * 24 * 3600_000).toISOString();
  const { data: calls } = await db.from("calls").select("id").lt("created_at", cutoff).gte("created_at", since);
  const { data: leads } = await db.from("leads").select("call_id").gte("created_at", since);
  const have = new Set((leads ?? []).map((l) => l.call_id));
  const orphans = (calls ?? []).filter((c) => !have.has(c.id)).slice(0, 5);
  for (const c of orphans) {
    try {
      await processCall(db, deps, c.id);
    } catch (e) {
      console.error("recover call failed", c.id, e);
    }
  }
  out.recoveredCalls = orphans.length;

  const { data: unrouted } = await db.from("leads").select("id").is("routed_at", null).lt("created_at", cutoff).limit(10);
  for (const l of unrouted ?? []) {
    try {
      await routeLead(db, deps, l.id);
    } catch (e) {
      console.error("route failed", l.id, e);
    }
  }
  out.routedLeads = unrouted?.length ?? 0;

  out.bookings = deps.booking ? await syncBookingStatuses(db, deps.booking, now) : "not configured";
  out.notifications = await processDue(db, deps);
  out.hubspot = deps.crm ? await syncPending(db, deps.crm, now) : "not configured";
  return Response.json({ ok: true, ...out });
}
