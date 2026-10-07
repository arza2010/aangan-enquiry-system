/**
 * One-off: point the Telegram bot at our webhook, and print the bot's recent chats so you can find chat ids.
 * Usage: npm run telegram:setup            (sets webhook to APP_BASE_URL/api/telegram; needs a PUBLIC https URL)
 *        npm run telegram:setup -- --chats  (just list chat ids from recent messages to the bot)
 *        npm run telegram:setup -- --test   (send a hello to the front desk and Nikhil chats from .env.local)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set in .env.local");
  process.exit(1);
}
const api = async (method: string, body?: object) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return (await r.json()) as { ok: boolean; result?: unknown; description?: string };
};

async function main() {
  if (process.argv.includes("--test")) {
    for (const [label, id] of [["front desk", process.env.TELEGRAM_FRONTDESK_CHAT_ID], ["Nikhil", process.env.TELEGRAM_NIKHIL_CHAT_ID]] as const) {
      if (!id) { console.log(`${label}: chat id not set in .env.local`); continue; }
      const r = await api("sendMessage", { chat_id: id, text: "✅ Aangan Studio bot is connected. You will get new-enquiry alerts here." });
      console.log(`${label}: ${r.ok ? "sent" : "FAILED - " + r.description}`);
    }
    return;
  }
  if (process.argv.includes("--chats")) {
    // getUpdates only works while no webhook is set, so drop it first if needed.
    const info = (await api("getWebhookInfo")).result as { url?: string };
    if (info?.url) console.log(`Note: a webhook is set (${info.url}); getUpdates will be empty until it is removed.`);
    const r = await api("getUpdates");
    type Chat = { id: number; type?: string; title?: string; first_name?: string };
    const seen = new Map<string, string>();
    for (const u of (r.result as Record<string, { chat?: Chat }>[]) ?? []) {
      // Plain messages, "bot was added/removed" events, and channel posts all carry a chat.
      for (const key of ["message", "my_chat_member", "channel_post", "edited_message"]) {
        const c = u[key]?.chat;
        if (c) seen.set(String(c.id), `${c.title ?? c.first_name ?? "?"} (${c.type ?? "chat"})`);
      }
    }
    if (seen.size === 0) {
      console.log("No chats seen yet. In Telegram: (1) open the bot privately and press Start; (2) in the group send /start@<your_bot_username>");
      console.log("(bots in groups cannot see ordinary messages, only commands, @mentions and replies); then run this again.");
    }
    console.table([...seen].map(([id, name]) => ({ chat_id: id, name })));
    return;
  }
  const base = process.env.APP_BASE_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!base?.startsWith("https://")) {
    console.error("APP_BASE_URL must be a public https URL (use ngrok locally). Telegram will not call localhost.");
    process.exit(1);
  }
  if (!secret) {
    console.error("TELEGRAM_WEBHOOK_SECRET is not set (any random string of letters, digits, _ or -).");
    process.exit(1);
  }
  const r = await api("setWebhook", { url: `${base}/api/telegram`, secret_token: secret, allowed_updates: ["callback_query", "message"] });
  console.log(r.ok ? `Webhook set to ${base}/api/telegram` : `Failed: ${r.description}`);
}
main();
