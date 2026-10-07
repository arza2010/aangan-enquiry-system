import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildDeps } from "@/lib/deps";
import { telegramClient } from "@/lib/telegram";
import { handleCallbackQuery, type CallbackQuery } from "@/lib/telegram-callbacks";

/**
 * Telegram bot webhook (button taps). Register with `npm run telegram:setup`, which sets a secret token that
 * Telegram echoes back in X-Telegram-Bot-Api-Secret-Token.
 */
export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  const update = (await req.json().catch(() => null)) as { callback_query?: CallbackQuery; message?: { chat: { id: number; type?: string }; text?: string } } | null;

  // "/start" or "/id" (also "/start@botname" in a group): reply with this chat's id, so designers can tell the
  // front desk their id without any developer tooling. Harmless to expose: an id alone grants nothing.
  const msg = update?.message;
  if (msg?.text && /^\/(start|id)(@\w+)?(\s|$)/i.test(msg.text)) {
    const reply = `Your chat ID is <code>${msg.chat.id}</code>.\nSend this number to the front desk so Aangan Studio can send you lead alerts here.`;
    await telegramClient().send(String(msg.chat.id), reply).catch(() => {});
    return Response.json({ ok: true });
  }

  const cq = update?.callback_query;
  if (!cq?.data || !cq.message) return Response.json({ ok: true }); // otherwise we only act on button taps

  const db = supabaseAdmin();
  await handleCallbackQuery(db, await buildDeps(db), cq);
  return Response.json({ ok: true });
}
