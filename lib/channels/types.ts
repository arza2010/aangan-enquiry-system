/**
 * The only shape the rest of the system knows about. Every channel adapter
 * (vaani.ts today, whatsapp.ts / webform.ts later) maps its provider payload to this.
 * Downstream code must never read the raw provider payload.
 */
export type Channel = "phone" | "whatsapp" | "webform";

export interface NormalisedEnquiry {
  channel: Channel;
  external_id: string;
  caller_phone: string; // E.164
  started_at: string; // ISO 8601
  ended_at: string | null;
  duration_sec: number | null;
  transcript: string;
  language: string | null;
  recording_url?: string;
  provider_cost_credits?: number | null; // provider's own billed cost, if the channel reports it
  raw: unknown; // kept for audit only
}
