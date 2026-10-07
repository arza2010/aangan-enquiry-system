import { readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_NAME = "Aangan Studio";
export const GREETING = "Hello, Aangan Studio. How can I help you today?";

/** The prompt file plus the two things only the operator knows. Pure, so it is unit-tested. */
export function buildSystemPrompt(raw: string, opts: { fallbackEmail: string; smsLive: boolean }): string {
  let p = raw.replace(/FALLBACK_EMAIL_HERE/g, opts.fallbackEmail);
  // Until a real SMS provider is connected the agent must not promise a text message the caller will never get.
  if (!opts.smsLive) p = p.replace(/, and tell them they will get a confirmation message shortly/, "");
  return p.trim();
}

/** The sections we set via Vaani's API. Providers (STT / LLM / voice) are left at Vaani's defaults on purpose. */
export function buildAgentConfig(systemPrompt: string) {
  return {
    persona: {
      identity: {
        system_prompt: systemPrompt,
        greeting_message: { agent_message: GREETING, interruptible: true, let_user_speak_first: false },
      },
      senses_capabilities: { language: "en", auto_detect: true },
    },
    experience: {
      settings: {
        call_settings: { max_duration_enabled: true, max_call_duration: 6 },
        idle_conversation_settings: { pulse_check: true, end_conversation_on_idle: true, idle_call_hangup_timeout: 20, idle_call_warning_timeout: 10 },
      },
    },
  };
}

export const loadAgentPrompt = (root = process.cwd()) => readFileSync(join(root, "prompts", "vaani-agent.md"), "utf8");
