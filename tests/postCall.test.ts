import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "@/lib/ai/provider";
import { runPostCall } from "@/lib/ai/postCall";
import { hasPriceLeak } from "@/lib/ai/priceGuard";

const good = {
  call_type: "new_enquiry", caller_name: "Priya", project_type: "home", location: "Kothrud",
  carpet_area_sqft: 1400, bhk_or_rooms: "3BHK", scope: "full redesign", budget_range: null,
  timeline: "by March", possession_status: "ready", source: "referral", language: "en",
  classification: "qualified", classification_reason: "Passes all five criteria in qualified.md.",
  missing_info: [], handoff_note: "Priya wants a full 3BHK redesign in Kothrud.", price_mentioned_in_call: false,
};

function fakeClient(outputs: string[]) {
  const create = vi.fn();
  outputs.forEach((o) => create.mockResolvedValueOnce({ text: o, usage: { input_tokens: 100, output_tokens: 50 } }));
  const provider = { name: "gemini", model: "fake", complete: create } as unknown as LlmProvider;
  return { client: provider, create };
}

describe("runPostCall", () => {
  it("accepts valid JSON, even wrapped in fences", async () => {
    const { client } = fakeClient(["```json\n" + JSON.stringify(good) + "\n```"]);
    const r = await runPostCall({ transcript: "x", provider: client });
    expect(r.ok).toBe(true);
  });

  it("retries once on invalid JSON, sums token usage, then succeeds", async () => {
    const { client, create } = fakeClient(["not json", JSON.stringify(good)]);
    const r = await runPostCall({ transcript: "x", provider: client });
    expect(r.ok && r.attempts).toBe(2);
    expect(r.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("returns ok:false (never throws) after the retry also fails", async () => {
    const { client } = fakeClient(["nope", '{"classification":"maybe"}']);
    const r = await runPostCall({ transcript: "x", provider: client });
    expect(r.ok).toBe(false);
  });

  it("never lets a price into the handoff note, even if the model keeps leaking", async () => {
    const leaky = { ...good, handoff_note: "Budget ₹12 lakh, wants 2,200 per sq ft." };
    const { client } = fakeClient([JSON.stringify(leaky), JSON.stringify(leaky)]);
    const r = await runPostCall({ transcript: "x", provider: client });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(hasPriceLeak(r.data.handoff_note)).toBe(false);
      expect(r.flags).toContain("handoff_note_redacted");
    }
  });

  it("rejects notes over 120 words", async () => {
    const long = { ...good, handoff_note: Array(130).fill("word").join(" ") };
    const { client } = fakeClient([JSON.stringify(long), JSON.stringify(good)]);
    const r = await runPostCall({ transcript: "x", provider: client });
    expect(r.ok && r.attempts).toBe(2);
  });

  it("only ever sends services.md + qualified.md as context (never the pricing guide)", async () => {
    const { client, create } = fakeClient([JSON.stringify(good)]);
    await runPostCall({ transcript: "x", provider: client });
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain("Aangan Studio — Services");
    expect(system).toContain("What makes an enquiry worth a designer");
    expect(system).not.toMatch(/Internal Pricing Guide/i);
    for (const fig of ["1,800", "2,400", "3,500", "1,200", "2,800", "4,000", "per sq ft"]) expect(system).not.toContain(fig);
  });
});
