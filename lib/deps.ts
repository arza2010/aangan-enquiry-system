import type { TelegramClient } from "./telegram";
import { telegramClient } from "./telegram";
import type { SmsProvider } from "./sms";
import { smsProvider } from "./sms";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrmClient } from "./crm/types";
import type { BookingProvider } from "./booking/types";
import { calcomFromEnv } from "./booking/calcom";
import { hubspotFromEnv } from "./crm/hubspot";
import { loadSettings } from "./settings";

/** External effects, injectable so tests never touch Telegram, SMS or HubSpot. */
export interface Deps {
  telegram: TelegramClient;
  sms: SmsProvider;
  crm: CrmClient | null; // null = HubSpot not configured
  booking?: BookingProvider | null; // null/undefined = Cal.com not configured
  now: () => Date;
}

/** Real dependencies for production. HubSpot is only wired when HUBSPOT_ACCESS_TOKEN is set. */
export async function buildDeps(db: SupabaseClient): Promise<Deps> {
  const settings = await loadSettings(db);
  return { telegram: telegramClient(), sms: smsProvider(), crm: hubspotFromEnv(settings), booking: calcomFromEnv(), now: () => new Date() };
}
