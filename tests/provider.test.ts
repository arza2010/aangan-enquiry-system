import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import { anthropicProvider, geminiProvider, getProvider } from "@/lib/ai/provider";

describe("LLM providers", () => {
  it("anthropic: maps request and usage", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } });
    const p = anthropicProvider({ client: { messages: { create } } as unknown as Anthropic, model: "claude-sonnet-5-5" });
    const r = await p.complete({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(r).toEqual({ text: "{}", usage: { input_tokens: 10, output_tokens: 5 } });
    const sent = create.mock.calls[0][0];
    expect(sent.model).toBe("claude-sonnet-5-5");
    expect(sent.system).toBe("sys");
    expect(sent).not.toHaveProperty("temperature"); // rejected on this model family
  });

  it("gemini: JSON mode, system instruction, assistant->model role, thinking tokens billed as output", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: "{}",
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
    });
    const p = geminiProvider({ client: { models: { generateContent } } as unknown as GoogleGenAI, model: "gemini-test" });
    const r = await p.complete({
      system: "sys",
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    });
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    const sent = generateContent.mock.calls[0][0];
    expect(sent.config.responseMimeType).toBe("application/json");
    expect(sent.config.systemInstruction).toBe("sys");
    expect(sent.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("getProvider picks by env: explicit > anthropic key > gemini key > error", () => {
    const saved = { ...process.env };
    try {
      delete process.env.AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY;
      expect(() => getProvider()).toThrow(/No LLM configured/);
      process.env.GEMINI_API_KEY = "g";
      expect(getProvider().name).toBe("gemini");
      process.env.ANTHROPIC_API_KEY = "a";
      expect(getProvider().name).toBe("anthropic");
      process.env.AI_PROVIDER = "gemini";
      expect(getProvider().name).toBe("gemini");
    } finally {
      process.env = saved;
    }
  });
});
