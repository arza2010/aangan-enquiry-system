import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildDeps } from "@/lib/deps";
import { offerSlots } from "@/lib/booking/service";
import { toolAuthorised } from "@/lib/booking/tool-auth";
import { fmtWhen } from "@/lib/time";

/** Vaani tool: "check_availability". Returns 2-3 slots the agent can read out. Optional body fields are accepted and ignored (one shared calendar). */
export async function POST(req: Request) {
  if (!toolAuthorised(req)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const db = supabaseAdmin();
  const deps = await buildDeps(db);
  if (!deps.booking) return Response.json({ slots: [], available: false, message: "Booking is not set up. Offer a callback window instead." });

  const now = deps.now();
  const slots = await offerSlots(db, deps.booking, now);
  return Response.json({
    available: slots.length > 0,
    slots: slots.map((s) => ({ slot_id: s, label: fmtWhen(new Date(s), now) })),
    message: slots.length ? undefined : "No free consult slots in the next 48 hours. Offer a callback window instead.",
  });
}
