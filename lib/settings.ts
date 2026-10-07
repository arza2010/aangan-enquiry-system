import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SettingsMap = Record<string, unknown>;

export async function loadSettings(db: SupabaseClient): Promise<SettingsMap> {
  const { data, error } = await db.from("settings").select("key, value");
  if (error) throw new Error(`settings load failed: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value]));
}

export const num = (s: SettingsMap, key: string, fallback = 0): number => {
  const v = s[key];
  return typeof v === "number" ? v : typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : fallback;
};

import type { Hours, TimingSettings } from "./time";

const asHours = (v: unknown, fallback: Hours): Hours =>
  v && typeof v === "object" && "start" in v && "end" in v ? (v as Hours) : fallback;

export function timingFrom(s: SettingsMap): TimingSettings {
  return {
    hours: asHours(s.working_hours, { start: "10:00", end: "19:00" }),
    workingDays: Array.isArray(s.working_days) ? (s.working_days as number[]) : [1, 2, 3, 4, 5, 6],
    slaMinutes: num(s, "sla_accept_minutes", 30),
    afterHoursDeadline: typeof s.sla_after_hours_deadline === "string" ? s.sla_after_hours_deadline : "10:30",
    callbackMinutes: num(s, "callback_promise_minutes", 60),
    afterHoursCallback: typeof s.after_hours_callback_time === "string" ? s.after_hours_callback_time : "11:00",
  };
}

export const quietHoursFrom = (s: SettingsMap): Hours => asHours(s.quiet_hours, { start: "21:00", end: "08:00" });
