import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { toE164 } from "../phone";
import type { NormalisedEnquiry } from "./types";

/**
 * Vaani adapter. Shapes below come from https://docs.vaanivoice.ai (Webhook Setup + Get Call History).
 * Nothing outside this folder may read the raw Vaani payload.
 *
 * Two sources are needed per call:
 *  1. the `call_postprocessing` webhook: transcript, summary, duration (MILLISECONDS), recording url
 *  2. GET /api/call-history: caller number (`from_number`), start time, and billed credits.
 *     The webhook does NOT carry the caller's number.
 */

// ── webhook ─────────────────────────────────────────────────────────────────────────────────
const WebhookEnvelope = z.object({ event: z.string(), call_id: z.string().optional() }).passthrough();

// Real Vaani payloads carry explicit nulls (entities, dispositions, summary...), so every optional field is nullish.
const PostProcessing = z
  .object({
    event: z.literal("call_postprocessing"),
    call_id: z.string(),
    timestamp: z.string().nullish(), // when post-processing finished (UTC, ISO)
    data: z
      .object({
        call_id: z.string().nullish(),
        room_name: z.string().nullish(),
        call_duration: z.number().nullish(), // ms in this event (seconds in call_ended)
        end_reason: z.string().nullish(),
        summary: z.string().nullish(),
        transcript: z.string().nullish(),
        recording_url: z.string().nullish(),
        entities: z.unknown().optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type VaaniPostProcessing = z.infer<typeof PostProcessing>;

/** Which event is this? Everything except call_postprocessing is acknowledged and ignored. */
export function vaaniEventName(raw: unknown): string | null {
  const p = WebhookEnvelope.safeParse(raw);
  return p.success ? p.data.event : null;
}

// ── call-history record ─────────────────────────────────────────────────────────────────────
export const VaaniCallMetaSchema = z
  .object({
    call_id: z.string(),
    from_number: z.string().nullish(),
    to_number: z.string().nullish(),
    direction: z.string().nullish(),
    Start_time: z.string().nullish(),
    End_time: z.string().nullish(),
    duration_ms: z.number().nullish(),
    call_cost: z.number().nullish(), // credits
  })
  .passthrough();
export type VaaniCallMeta = z.infer<typeof VaaniCallMetaSchema>;

/** Vaani's call-history timestamps are naive ISO strings; treat them as UTC (assumed, see open-questions). */
const asUtc = (s: string) => new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);

/**
 * "[13:33:14] AGENT: hi\n[13:33:19] USER: hello" -> "Agent: hi\nCaller: hello".
 * Vaani separates turns with a blank line in docs examples but with single newlines in real payloads, and the welcome
 * line has no timestamp, so work line by line. Timestamps cost tokens and add nothing.
 */
export function cleanTranscript(t: string): string {
  return t
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[\d:.]+\]\s*/, "").replace(/^AGENT:/i, "Agent:").replace(/^USER:/i, "Caller:").trim())
    .filter(Boolean)
    .join("\n");
}

export const UNKNOWN_PHONE = "unknown";

/** If a payload already carries the caller's number (test replays; possibly Vaani later), we need no call-history lookup. */
export function inlinePhone(raw: unknown): string | null {
  const r = raw as { from_number?: string; caller_number?: string; data?: { from_number?: string; caller_number?: string } } | null;
  return r?.data?.from_number ?? r?.data?.caller_number ?? r?.from_number ?? r?.caller_number ?? null;
}

export function normaliseVaani(raw: unknown, meta?: VaaniCallMeta | null): NormalisedEnquiry {
  const parsed = PostProcessing.parse(raw);
  // Vaani's own page shows the fields under `data` in the JSON but at top level in the Python sample: accept both.
  const p = { ...parsed, data: { ...(parsed as Record<string, unknown>), ...(parsed.data ?? {}) } } as unknown as {
    call_id: string;
    timestamp?: string | null;
    data: { call_duration?: number | null; transcript?: string | null; recording_url?: string | null };
  };
  const endedAt = p.timestamp ? asUtc(p.timestamp) : new Date();
  const durationSec =
    p.data.call_duration != null
      ? Math.round(p.data.call_duration / 1000)
      : meta?.duration_ms != null
        ? Math.round(meta.duration_ms / 1000)
        : null;
  const startedAt = meta?.Start_time
    ? asUtc(meta.Start_time)
    : new Date(endedAt.getTime() - (durationSec ?? 0) * 1000);

  return {
    channel: "phone",
    external_id: p.call_id,
    caller_phone: (meta?.from_number ?? inlinePhone(raw)) ? toE164((meta?.from_number ?? inlinePhone(raw))!) : UNKNOWN_PHONE,
    started_at: startedAt.toISOString(),
    ended_at: meta?.End_time ? asUtc(meta.End_time).toISOString() : endedAt.toISOString(),
    duration_sec: durationSec,
    transcript: cleanTranscript(p.data.transcript ?? ""),
    language: null, // Vaani does not report it; the post-call LLM detects it
    recording_url: p.data.recording_url ?? undefined,
    provider_cost_credits: meta?.call_cost ?? null,
    raw,
  };
}

// ── auth ────────────────────────────────────────────────────────────────────────────────────
/**
 * Vaani documents no webhook signature, so the endpoint is protected by a long random token in the
 * URL we register in Vaani's dashboard: https://<app>/api/webhooks/vaani?token=<VAANI_WEBHOOK_SECRET>
 */
export function verifyWebhookToken(given: string | null, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
