/**
 * Provider-agnostic SMS. The real provider is still an open question (docs/open-questions.md #12), so only
 * `console` (logs, sends nothing) exists. To add one, implement SmsProvider and register it in `smsProvider()`.
 */
export interface SmsProvider {
  name: string;
  send(to: string, text: string): Promise<void>;
}

export const consoleSms: SmsProvider = {
  name: "console",
  async send(to, text) {
    console.log(`[sms:console] to ${to}: ${text}`);
  },
};

export function smsProvider(): SmsProvider {
  const name = (process.env.SMS_PROVIDER ?? "").toLowerCase();
  if (name === "" || name === "console") return consoleSms;
  throw new Error(`SMS provider "${name}" is not implemented yet: add it in lib/sms.ts`);
}
