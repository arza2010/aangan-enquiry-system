import { describe, expect, it } from "vitest";
import { buildAgentConfig, buildSystemPrompt, loadAgentPrompt } from "@/lib/vaani-agent";
import { hasPriceLeak } from "@/lib/ai/priceGuard";

describe("vaani agent setup", () => {
  const raw = loadAgentPrompt();
  it("fills the fallback email and leaves no placeholder", () => {
    const p = buildSystemPrompt(raw, { fallbackEmail: "inbox@x.com", smsLive: true });
    expect(p).toContain("inbox@x.com");
    expect(p).not.toContain("FALLBACK_EMAIL_HERE");
  });
  it("does not promise a confirmation message until SMS is live", () => {
    expect(buildSystemPrompt(raw, { fallbackEmail: "a@b.c", smsLive: false })).not.toMatch(/confirmation message/);
    expect(buildSystemPrompt(raw, { fallbackEmail: "a@b.c", smsLive: true })).toMatch(/confirmation message/);
  });
  it("never ships a price figure and keeps the hard rule", () => {
    const p = buildSystemPrompt(raw, { fallbackEmail: "a@b.c", smsLive: false });
    expect(hasPriceLeak(p.replace(/per square foot/gi, ""))).toBe(false);
    expect(p).toMatch(/never give any price/i);
  });
  it("builds a config with the greeting, auto language detection and a 6-minute cap", () => {
    const c = buildAgentConfig("PROMPT");
    expect(c.persona.identity.greeting_message.agent_message).toBe("Hello, Aangan Studio. How can I help you today?");
    expect(c.persona.senses_capabilities).toMatchObject({ language: "en", auto_detect: true });
    expect(c.experience.settings.call_settings.max_call_duration).toBe(6);
  });
});
