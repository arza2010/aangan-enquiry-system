export type RecipientType = "designer" | "front_desk" | "nikhil" | "caller";

export const frontDeskChat = () => process.env.TELEGRAM_FRONTDESK_CHAT_ID ?? null;
export const nikhilChat = () => process.env.TELEGRAM_NIKHIL_CHAT_ID ?? null;

/** Who may press Accept / Reassign: the assigned designer, the front desk group, or Nikhil. */
export function isAuthorised(chatId: string, designerChatId: string | null): boolean {
  return chatId === designerChatId || chatId === frontDeskChat() || chatId === nikhilChat();
}
