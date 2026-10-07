import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

/**
 * The only place that knows which LLM vendor is in use. The brief specifies Claude; Gemini is supported
 * so the pilot can run on whichever key is available. Prompts, Zod validation, the price guard and
 * cost logging are vendor-independent.
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface LlmRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface LlmProvider {
  name: "anthropic" | "gemini";
  model: string;
  complete(req: LlmRequest): Promise<{ text: string; usage: Usage }>;
}

export const DEFAULT_MODELS = { anthropic: "claude-sonnet-5-5", gemini: "gemini-3.8-flash" } as const;

export function anthropicProvider(opts: { client?: Anthropic; model?: string } = {}): LlmProvider {
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODELS.anthropic;
  return {
    name: "anthropic",
    model,
    async complete({ system, messages }) {
      const client = opts.client ?? new Anthropic();
      // Sonnet 5.5: thinking is on by default, sampling params must stay default, forced tool_choice is rejected.
      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages,
        output_config: { effort: "medium" },
      });
      return {
        text: res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
        usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
      };
    },
  };
}

export function geminiProvider(opts: { client?: GoogleGenAI; model?: string } = {}): LlmProvider {
  const model = opts.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODELS.gemini;
  return {
    name: "gemini",
    model,
    async complete({ system, messages }) {
      const ai = opts.client ?? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const res = await ai.models.generateContent({
        model,
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          maxOutputTokens: 8192, // headroom: thinking tokens count against this
        },
      });
      const u = res.usageMetadata;
      return {
        text: res.text ?? "",
        // Thinking tokens are billed as output.
        usage: { input_tokens: u?.promptTokenCount ?? 0, output_tokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) },
      };
    },
  };
}

/** AI_PROVIDER=anthropic|gemini wins; otherwise use whichever API key is present (Anthropic first, as the brief specifies). */
export function getProvider(): LlmProvider {
  const pick = process.env.AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.GEMINI_API_KEY ? "gemini" : "");
  if (pick === "anthropic") return anthropicProvider();
  if (pick === "gemini") return geminiProvider();
  throw new Error("No LLM configured: set ANTHROPIC_API_KEY or GEMINI_API_KEY (and optionally AI_PROVIDER)");
}
