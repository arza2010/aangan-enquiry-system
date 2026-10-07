import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildDeps } from "@/lib/deps";
import { bookSlot } from "@/lib/booking/service";
import { toolAuthorised } from "@/lib/booking/tool-auth";
import { toE164 } from "@/lib/phone";
import { fmtWhen } from "@/lib/time";

const Body = z.object({ slot_id: z.string().datetime({ offset: true }), name: z.string().min(1).max(100), phone: z.string().min(6).max(20), call_id: z.string().min(1).optional() });

/**
 * Vaani tool: "book_slot". The agent cannot know Vaani's call id, so call_id is optional; after the call we find the booking by
 * time window (see linkBookingToCall). Idempotent on (call_id, slot) or, without a call id, on (phone, slot). Starts provisional: it is only confirmed once the lead qualifies. */
export async function POST(req: Request) {
  if (!toolAuthorised(req)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body", details: parsed.error.issues.map((i) => i.path.join(".")) }, { status: 400 });

  const db = supabaseAdmin();
  const deps = await buildDeps(db);
  if (!deps.booking) return Response.json({ booked: false, message: "Booking is not set up. Promise a callback window instead." }, { status: 503 });

  const r = await bookSlot(db, deps.booking, { vaaniCallId: parsed.data.call_id ?? `tool-${randomUUID()}`, start: parsed.data.slot_id, name: parsed.data.name, phone: toE164(parsed.data.phone) });
  if (!r.ok) {
    return Response.json(
      { booked: false, reason: r.reason, message: r.reason === "slot_taken" ? "That slot was just taken. Offer the caller another." : "Could not book. Promise a callback window instead." },
      { status: r.reason === "slot_taken" ? 409 : 502 },
    );
  }
  return Response.json({ booked: true, duplicate: r.duplicate, when: fmtWhen(new Date(r.booking.slot_start), deps.now()), slot_start: r.booking.slot_start });
}
