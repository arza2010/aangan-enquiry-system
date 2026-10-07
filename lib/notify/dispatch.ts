import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Deps } from "@/lib/deps";
import { loadSettings, num, type SettingsMap } from "@/lib/settings";
import { logCost } from "@/lib/costs";
import { addMinutes, hhmmToMin, istParts, istDate } from "@/lib/time";
import * as T from "./templates";
import { enqueue } from "./queue";
import { frontDeskChat, nikhilChat } from "./recipients";

const MAX_ATTEMPTS = 5;

const recipientLabel = (row: { channel: string; recipient_type: string }, designerName: string | null) => {
  switch (row.recipient_type) {
    case "designer": return `Designer: ${designerName ?? "unknown"}`;
    case "front_desk": return "Front desk group";
    case "nikhil": return "Nikhil";
    default: return row.channel;
  }
};

interface Row {
  id: string;
  lead_id: string | null;
  type: string;
  channel: "telegram" | "sms";
  recipient_type: string;
  recipient_chat_id: string | null;
  payload: { designer_id?: string | null };
  attempts: number;
  scheduled_for: string;
}

async function loadCtx(db: SupabaseClient, leadId: string, settings: SettingsMap, deps: Deps) {
  const { data: lead } = await db.from("leads").select("*").eq("id", leadId).single();
  if (!lead) return null;
  const { data: call } = await db.from("calls").select("caller_phone").eq("id", lead.call_id).single();
  const designer = lead.assigned_designer_id ? (await db.from("designers").select("*").eq("id", lead.assigned_designer_id).single()).data : null;
  const { data: bookings } = await db.from("bookings").select("*").eq("lead_id", leadId).in("status", ["provisional", "confirmed"]);
  const range = settings.project_value_range_lakh as { min: number; max: number } | undefined;
  const ctx: T.Ctx = {
    now: deps.now(),
    baseUrl: process.env.APP_BASE_URL ?? "",
    lead,
    callerPhone: call?.caller_phone ?? "unknown",
    designerName: designer?.name ?? null,
    booking: bookings?.[0] ?? null,
    project_value_range: range,
  };
  return { ctx, lead, designer };
}

/** Is this alert still worth sending? A reminder to someone who already accepted is noise. */
function staleReason(row: Row, lead: Record<string, unknown>, booking: unknown): string | null {
  const reassigned = row.payload.designer_id && lead.assigned_designer_id !== row.payload.designer_id;
  switch (row.type) {
    case "lead_assigned":
    case "reminder":
      if (reassigned) return "lead reassigned";
      return lead.accepted_at ? "already accepted" : null;
    case "sla_breach":
      if (reassigned) return "lead reassigned";
      return lead.accepted_at ? "already accepted" : null;
    case "call_reminder":
      return !booking ? "booking cancelled" : reassigned ? "lead reassigned" : null;
    default:
      return null;
  }
}

async function digestStats(db: SupabaseClient, now: Date): Promise<T.DigestStats> {
  const since = addMinutes(now, -24 * 60).toISOString();
  const { data: calls } = await db.from("calls").select("id").gte("created_at", since);
  const { data: leads } = await db.from("leads").select("classification, needs_review, status").gte("created_at", since);
  const { data: bookings } = await db.from("bookings").select("id").gte("created_at", since).in("status", ["provisional", "confirmed"]);
  return {
    calls: calls?.length ?? 0,
    qualified: (leads ?? []).filter((l) => l.classification === "qualified").length,
    booked: bookings?.length ?? 0,
    pendingReview: (leads ?? []).filter((l) => l.status === "in_review").length,
  };
}

/** Queue the daily digest once, after digest_time IST (dedupe key = the IST date). */
export async function maybeEnqueueDigest(db: SupabaseClient, now: Date, settings: SettingsMap) {
  const at = typeof settings.digest_time === "string" ? settings.digest_time : "09:30";
  const p = istParts(now);
  if (p.minutes < hhmmToMin(at)) return;
  const day = `${p.y}-${p.m + 1}-${p.d}`;
  for (const [who, chat] of [["front_desk", frontDeskChat()], ["nikhil", nikhilChat()]] as const) {
    await enqueue(db, { lead_id: null, recipient_type: who, chat_id: chat, type: "digest", scheduled_for: istDate(p.y, p.m, p.d, hhmmToMin(at)), dedupe_key: `digest:${day}:${who}` });
  }
}

function render(row: Row, c: NonNullable<Awaited<ReturnType<typeof loadCtx>>>["ctx"]): T.Rendered | string | null {
  switch (row.type) {
    case "new_enquiry": return T.newEnquiry(c);
    case "lead_assigned": return T.leadAssigned(c);
    case "reminder": return T.reminder(c);
    case "sla_breach": return T.slaBreach(c);
    case "call_reminder": return T.callReminder(c);
    case "needs_review": return T.needsReview(c);
    case "escalation": return T.escalation(c);
    case "caller_sms": return T.callerSms(c);
    case "booking_cancelled": return T.callerCancelSms(c);
    default: return null;
  }
}

/** Send everything that is due. Safe to call every minute and to overlap: each row is claimed atomically before sending. */
export async function processDue(db: SupabaseClient, deps: Deps, limit = 50) {
  const now = deps.now();
  const settings = await loadSettings(db);
  await maybeEnqueueDigest(db, now, settings);

  const { data: due } = await db
    .from("notifications").select("*")
    .is("sent_at", null).is("cancelled_at", null)
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true }).limit(limit);

  const result = { sent: 0, cancelled: 0, failed: 0 };
  for (const row of (due ?? []) as Row[]) {
    // Atomic claim: push scheduled_for out, conditional on it being unchanged. If a webhook and the cron tick
    // race, only one UPDATE matches, so an alert is never sent twice. (A crash leaves it retried in 5 min.)
    const claim = await db
      .from("notifications")
      .update({ scheduled_for: addMinutes(now, 5).toISOString() })
      .eq("id", row.id)
      .eq("scheduled_for", row.scheduled_for)
      .is("sent_at", null)
      .is("cancelled_at", null)
      .select("id");
    if (!claim.data?.length) continue;
    try {
      let out: T.Rendered | string | null;
      let leadCallId: string | null = null;
      let designerName: string | null = null;

      if (row.type === "digest") {
        out = T.digest(await digestStats(db, now));
      } else {
        const loaded = row.lead_id ? await loadCtx(db, row.lead_id, settings, deps) : null;
        if (!loaded) throw new Error("lead not found");
        const stale = staleReason(row, loaded.lead, loaded.ctx.booking);
        if (stale) {
          await db.from("notifications").update({ cancelled_at: now.toISOString(), error: stale }).eq("id", row.id);
          result.cancelled++;
          continue;
        }
        leadCallId = loaded.lead.call_id;
        designerName = loaded.designer?.name ?? null;
        out = render(row, loaded.ctx);
      }
      if (!out) throw new Error(`no template for ${row.type}`);

      if (row.channel === "sms") {
        await deps.sms.send(row.recipient_chat_id!, out as string);
        await db.from("notifications").update({ sent_at: now.toISOString(), delivered: true }).eq("id", row.id);
        await logCost(db, { call_id: leadCallId, service: "sms", units: 1, unit_type: "messages", cost_inr: num(settings, "price_sms_inr_per_message"), detail: deps.sms.name });
      } else {
        const r = out as T.Rendered;
        const sent = await deps.telegram.send(row.recipient_chat_id!, r.text, r.buttons, { to: recipientLabel(row, designerName) });
        await db.from("notifications").update({ sent_at: now.toISOString(), delivered: true, telegram_message_id: sent.message_id }).eq("id", row.id);
        await logCost(db, { call_id: leadCallId, service: "telegram", units: 1, unit_type: "messages", cost_inr: num(settings, "price_telegram_inr_per_message") });
      }
      result.sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = row.attempts + 1;
      // Exponential backoff; after MAX_ATTEMPTS stop retrying but keep the row (and error) visible.
      await db.from("notifications").update(
        attempts >= MAX_ATTEMPTS
          ? { attempts, error: msg, cancelled_at: now.toISOString() }
          : { attempts, error: msg, scheduled_for: addMinutes(now, 2 ** attempts).toISOString() },
      ).eq("id", row.id);
      result.failed++;
      console.error(`notification ${row.id} (${row.type}) failed`, msg);
    }
  }
  return result;
}
