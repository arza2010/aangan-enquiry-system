import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Deps } from "./deps";
import { acceptLead, reassignLead } from "./lead-actions";
import { esc } from "./telegram";
import { fmtTime } from "./time";
import { processDue } from "./notify/dispatch";

export interface CallbackQuery {
  id: string;
  from?: { first_name?: string };
  message?: { message_id: number; chat: { id: number }; text?: string };
  data?: string;
}

/** Accept / Reassign button taps. Used by the real webhook route and by the simulator, so both run identical logic. */
export async function handleCallbackQuery(db: SupabaseClient, deps: Deps, cq: CallbackQuery) {
  if (!cq.data || !cq.message) return;
  const [action, leadId] = cq.data.split(":");
  if (!["a", "r"].includes(action) || !leadId) return;

  const chatId = String(cq.message.chat.id);
  const who = cq.from?.first_name ?? "someone";
  const res = action === "a" ? await acceptLead(db, deps, leadId, chatId) : await reassignLead(db, deps, leadId, chatId);
  await deps.telegram.answerCallback(cq.id, res.message).catch(() => {});

  if (res.ok) {
    const stamp = action === "a" ? `✅ Accepted by ${esc(res.designerName ?? who)} at ${fmtTime(deps.now())}` : `↪ ${esc(res.message)} (by ${esc(who)})`;
    // Telegram's callback payload has plain text only, so the edit drops bold; the buttons go away, which is the point.
    await deps.telegram.editMessage(chatId, cq.message.message_id, `${esc(cq.message.text ?? "")}\n\n${stamp}`).catch(() => {});
    if (action === "r") await processDue(db, deps); // the new designer is alerted immediately
  }
}
