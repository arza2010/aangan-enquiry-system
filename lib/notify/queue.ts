import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SettingsMap } from "@/lib/settings";
import { quietHoursFrom } from "@/lib/settings";
import { afterQuietHours } from "@/lib/time";
import type { RecipientType } from "./recipients";

export interface NewNotification {
  lead_id: string | null;
  recipient_type: RecipientType;
  chat_id: string | null; // telegram chat id, or phone number for SMS
  channel?: "telegram" | "sms";
  type: string;
  payload?: Record<string, unknown>;
  scheduled_for: Date;
  dedupe_key?: string;
}

/**
 * Add to the outbox. Every alert goes through here so it is stored (for alert-to-accept metrics),
 * retried by cron, and deduplicated. Returns false if an identical alert already exists.
 */
export async function enqueue(db: SupabaseClient, n: NewNotification): Promise<boolean> {
  const row = {
    lead_id: n.lead_id,
    recipient_type: n.recipient_type,
    recipient_chat_id: n.chat_id,
    channel: n.channel ?? "telegram",
    type: n.type,
    payload: n.payload ?? {},
    scheduled_for: n.scheduled_for.toISOString(),
    dedupe_key: n.dedupe_key ?? null,
    // No destination: keep a visible record instead of silently dropping it.
    ...(n.chat_id ? {} : { cancelled_at: new Date().toISOString(), error: "no recipient chat id / phone" }),
  };
  const { error } = await db.from("notifications").insert(row);
  if (error) {
    if (error.code === "23505") return false;
    throw new Error(`notification insert failed: ${error.message}`);
  }
  return true;
}

/** Designers get no alerts during quiet hours unless they opted in; front desk only if configured; Nikhil and callers never. */
export function sendTime(
  who: RecipientType,
  when: Date,
  settings: SettingsMap,
  designer?: { night_alerts: boolean } | null,
): Date {
  const quiet = quietHoursFrom(settings);
  if (who === "designer" && !designer?.night_alerts) return afterQuietHours(when, quiet);
  if (who === "front_desk" && settings.frontdesk_quiet_hours === true) return afterQuietHours(when, quiet);
  return when;
}

/** Cancel pending (unsent) notifications for a lead, e.g. once the designer accepts. */
export async function cancelPending(db: SupabaseClient, leadId: string, types: string[], now: Date, reason: string) {
  const { error } = await db
    .from("notifications")
    .update({ cancelled_at: now.toISOString(), error: reason })
    .eq("lead_id", leadId)
    .in("type", types)
    .is("sent_at", null)
    .is("cancelled_at", null);
  if (error) throw new Error(`cancel failed: ${error.message}`);
}
