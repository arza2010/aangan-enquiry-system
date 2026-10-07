import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DesignerRow } from "@/lib/routing";
import { addMinutes, computeCallbackDue, computeSlaDue } from "@/lib/time";
import { num, timingFrom, type SettingsMap } from "@/lib/settings";
import { enqueue, sendTime } from "@/lib/notify/queue";
import { frontDeskChat, nikhilChat } from "@/lib/notify/recipients";

export interface AssignInput {
  leadId: string;
  designer: DesignerRow & { night_alerts: boolean };
  booking: { id: string; slot_start: string; status: string } | null;
  settings: SettingsMap;
  now: Date;
  /** distinguishes a reassignment's alerts from the original ones (dedupe keys) */
  round?: string;
}

/**
 * Give a lead to a designer and queue everything that follows: the alert, the 10-min nudge, the SLA
 * escalation, the pre-call reminder. Shared by first routing and by Reassign.
 */
export async function assignAndNotify(db: SupabaseClient, a: AssignInput) {
  const t = timingFrom(a.settings);
  const slaDue = computeSlaDue(a.now, t);
  const callbackDue = a.booking ? new Date(a.booking.slot_start) : computeCallbackDue(a.now, t);
  const round = a.round ?? "0";

  const { error } = await db
    .from("leads")
    .update({
      assigned_designer_id: a.designer.id,
      status: "sent_to_designer",
      sla_due_at: slaDue.toISOString(),
      callback_due_at: callbackDue.toISOString(),
      accepted_at: null,
      hubspot_sync_status: "pending",
    })
    .eq("id", a.leadId);
  if (error) throw new Error(`lead assign failed: ${error.message}`);

  if (a.booking && a.booking.status === "provisional") {
    // Qualified lead: the consult is real. (The calendar event title is updated in step 5.)
    await db.from("bookings").update({ status: "confirmed", designer_id: a.designer.id }).eq("id", a.booking.id);
  }

  const alertAt = sendTime("designer", a.now, a.settings, a.designer);
  const meta = { designer_id: a.designer.id };
  await enqueue(db, {
    lead_id: a.leadId, recipient_type: "designer", chat_id: a.designer.telegram_chat_id, type: "lead_assigned",
    payload: meta, scheduled_for: alertAt, dedupe_key: `lead_assigned:${a.leadId}:${round}`,
  });
  // Nudge N min after the alert actually lands (so a queued overnight alert is not nudged at 9pm).
  await enqueue(db, {
    lead_id: a.leadId, recipient_type: "designer", chat_id: a.designer.telegram_chat_id, type: "reminder",
    payload: meta, scheduled_for: addMinutes(alertAt, num(a.settings, "reminder_after_minutes", 10)), dedupe_key: `reminder:${a.leadId}:${round}`,
  });
  for (const [who, chat] of [["front_desk", frontDeskChat()], ["nikhil", nikhilChat()]] as const) {
    await enqueue(db, {
      lead_id: a.leadId, recipient_type: who, chat_id: chat, type: "sla_breach",
      payload: meta, scheduled_for: slaDue, dedupe_key: `sla_breach:${a.leadId}:${round}:${who}`,
    });
  }
  if (a.booking) {
    const remindAt = addMinutes(new Date(a.booking.slot_start), -num(a.settings, "call_reminder_minutes", 15));
    if (remindAt.getTime() > a.now.getTime()) {
      await enqueue(db, {
        lead_id: a.leadId, recipient_type: "designer", chat_id: a.designer.telegram_chat_id, type: "call_reminder",
        payload: meta, scheduled_for: sendTime("designer", remindAt, a.settings, a.designer), dedupe_key: `call_reminder:${a.leadId}:${round}`,
      });
    }
  }
  return { slaDue, callbackDue };
}
