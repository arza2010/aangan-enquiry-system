import { z } from "zod";

/**
 * Validated, lazy env access. Server-only values are read on first use so `next build`
 * and tests don't need every secret present.
 */
const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.enum(["anthropic", "gemini"]).optional(),
  VAANI_API_KEY: z.string().optional(),
  VAANI_WEBHOOK_SECRET: z.string().optional(),
  VAANI_TOOL_SECRET: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_FRONTDESK_CHAT_ID: z.string().min(1),
  TELEGRAM_NIKHIL_CHAT_ID: z.string().min(1),
  CALCOM_API_KEY: z.string().optional(),
  CALCOM_EVENT_TYPE_ID: z.string().optional(),
  CALCOM_ATTENDEE_EMAIL: z.string().optional(),
  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_PORTAL_ID: z.string().optional(),
  CRON_SECRET: z.string().min(1),
  SMS_PROVIDER: z.string().optional(),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  APP_BASE_URL: z.string().url(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

const refined = serverSchema.refine((e) => e.ANTHROPIC_API_KEY || e.GEMINI_API_KEY, {
  message: "set ANTHROPIC_API_KEY or GEMINI_API_KEY",
  path: ["ANTHROPIC_API_KEY"],
});

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (!cached) {
    const parsed = refined.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid or missing environment variables: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}
