export interface Button {
  text: string;
  callback_data?: string; // max 64 bytes
  url?: string; // Telegram only accepts public https URLs
}

export interface TelegramClient {
  send(chatId: string, html: string, buttons?: Button[][], meta?: { to: string }): Promise<{ message_id: number }>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  editMessage(chatId: string, messageId: number, html: string, buttons?: Button[][]): Promise<void>;
}

export function telegramClient(token = process.env.TELEGRAM_BOT_TOKEN, f: typeof fetch = fetch): TelegramClient {
  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const res = await f(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    return json.result as T;
  }
  const markup = (b?: Button[][]) => (b?.length ? { reply_markup: { inline_keyboard: b } } : {});
  return {
    send: (chat_id, text, buttons) =>
      call<{ message_id: number }>("sendMessage", { chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markup(buttons) }),
    answerCallback: async (callback_query_id, text) => {
      await call("answerCallbackQuery", { callback_query_id, text });
    },
    editMessage: async (chat_id, message_id, text, buttons) => {
      await call("editMessageText", { chat_id, message_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markup(buttons ?? []) });
    },
  };
}

/** Escape user-supplied text for Telegram HTML parse mode. */
export const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A link button only works on a public https URL; on localhost it would make Telegram reject the whole message. */
export const canUseUrlButton = (url: string) => /^https:\/\//i.test(url);
