import { after } from "next/server";
import { inlinePhone, normaliseVaani, vaaniEventName, verifyWebhookToken } from "@/lib/channels/vaani";
import { fetchVaaniCallMeta } from "@/lib/channels/vaaniApi";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ingestCall } from "@/lib/pipeline/ingest";
import { processCall } from "@/lib/pipeline/process";
import { buildDeps } from "@/lib/deps";
import { syncPending } from "@/lib/crm/sync";

export const maxDuration = 60;

/**
 * Vaani webhook. Register as https://<app>/api/webhooks/vaani?token=<VAANI_WEBHOOK_SECRET>.
 * Vaani fires ~11 event types; only `call_postprocessing` carries the transcript, so the rest are acknowledged and ignored.
 */
export async function POST(req: Request) {
  const secret = process.env.VAANI_WEBHOOK_SECRET;
  if (secret) {
    if (!verifyWebhookToken(new URL(req.url).searchParams.get("token"), secret)) {
      return Response.json({ error: "unauthorised" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "webhook secret not configured" }, { status: 500 }); // fail closed
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (vaaniEventName(body) !== "call_postprocessing") return Response.json({ ok: true, ignored: true });

  const callId = (body as { call_id?: string }).call_id;
  if (!callId) return Response.json({ error: "missing call_id" }, { status: 400 });

  // The webhook has no caller number or start time; fetch them. If that fails we still store the call.
  const meta = inlinePhone(body) ? null : await fetchVaaniCallMeta(callId, process.env.VAANI_API_KEY);

  let enquiry;
  try {
    enquiry = normaliseVaani(body, meta);
  } catch (e) {
    console.error("vaani payload rejected", e instanceof Error ? e.message : e);
    return Response.json({ error: "unrecognised payload" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { callId: id, duplicate } = await ingestCall(db, enquiry);
  if (duplicate) return Response.json({ ok: true, duplicate: true, callId: id });

  after(async () => {
    try {
      const deps = await buildDeps(db);
      await processCall(db, deps, id);
      if (deps.crm) await syncPending(db, deps.crm, deps.now());
    } catch (e) {
      console.error("processCall failed", id, e); // call is stored; the cron tick retries calls without a lead
    }
  });

  return Response.json({ ok: true, callId: id });
}
