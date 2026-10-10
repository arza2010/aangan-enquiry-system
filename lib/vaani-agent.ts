import { readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_NAME = "Aangan Studio";
export const GREETING = "Hello, Aangan Studio. How can I help you today?";

/** The prompt file plus the two things only the operator knows. Pure, so it is unit-tested. */
const CALLBACK_ONLY = `# Next step: a designer callback
You cannot book calendar slots on this line, so never offer, name or promise a specific appointment time, and never pretend to book anything.
When you have the basics, say a designer will call them back: within the hour while the studio is open (10 am to 7 pm, Monday to Saturday), or by 11 the next working morning if it is closed.
Ask what number the designer should call them on (confirm it by repeating it) and whether a time of day suits them best, morning, afternoon or evening, and note it for the designer.
Never promise a particular designer, and never promise a site visit; a designer decides that at the consultation.

`;

export function buildSystemPrompt(raw: string, opts: { fallbackEmail: string; smsLive: boolean; booking?: boolean }): string {
  let p = raw.replace(/FALLBACK_EMAIL_HERE/g, opts.fallbackEmail);
  // Without working booking tools the agent must not talk about booking at all, or it will invent one.
  if (opts.booking === false) p = p.replace(/# Booking the consultation[\s\S]*?(?=# Special situations)/, CALLBACK_ONLY);
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
      senses_capabilities: {
        language: "en",
        auto_detect: true,
        // Vaani's default backup model is Azure gpt-4o, which Vaani has globally DISABLED. Any hiccup on the primary then killed
        // the call, and the agent config could not even be saved ("Provider 'azure' has been globally disabled").
        // Fast primary model: Vaani's default (gemini-3.5-flash) took 5-14 s per turn on this prompt, and Vaani's watcher hangs up
        // after 15 s of "thinking" (not configurable via the API). Short spoken replies need no more than 300 tokens.
        brain: { llm: { primary: { provider: "google", model: "gemini-3.5-flash-lite", parameters: { temperature: 0.5, top_p: 1, max_tokens: 300 } }, fallback: { provider: "google", model: "gemini-3.5-flash", parameters: { temperature: 0.7, top_p: 1, max_tokens: 500 } } } },
      },
    },
    experience: {
      settings: {
        call_settings: { max_duration_enabled: true, max_call_duration: 6 },
        // Vaani's defaults hang up after 10 s of initial silence and say "Hello?" after 3 s: far too impatient for real callers
        // (and for browser tests). Callers think, and the greeting takes a few seconds to land.
        idle_conversation_settings: {
          pulse_check: true, end_conversation_on_idle: true, idle_call_hangup_timeout: 45, idle_call_warning_timeout: 25,
          initial_idle_call_warning_timeout: 12, initial_idle_call_hungup_timeout: 40,
        },
        // Hang up on "too much background noise" only after many consecutive detections, not three.
        vad_watcher: { empty_transcript_wait: 8, max_consecutive_noise: 8 },
      },
      conversational_experience: { eagerness_to_speak: "balanced" },
    },
  };
}

export const loadAgentPrompt = (root = process.cwd()) => readFileSync(join(root, "prompts", "vaani-agent.md"), "utf8");
