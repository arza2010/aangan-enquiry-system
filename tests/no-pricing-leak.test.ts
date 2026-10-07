import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasPriceLeak } from "@/lib/ai/priceGuard";

// Hard rule #1: pricing.md is never given to Vaani or the LLM. This fails if any source file references it.
const ROOTS = ["app", "lib", "prompts", "scripts", "context", "supabase"];

function walk(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  } catch {
    return [];
  }
}

describe("pricing.md isolation", () => {
  it("is not referenced anywhere the app or prompts can reach", () => {
    const hits = ROOTS.flatMap(walk)
      .filter((p) => /\.(ts|tsx|md|sql|json)$/.test(p))
      .filter((p) => /pricing\.md/i.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the voice agent prompt itself contains no price, rate or currency figure, and no qualification rubric", () => {
    const prompt = readFileSync("prompts/vaani-agent.md", "utf8");
    // The prompt legitimately says the words "price"/"pricing" (to forbid it); what must never appear is a figure.
    expect(hasPriceLeak(prompt.replace(/per square foot/gi, "per area unit"))).toBe(false);
    expect(prompt).not.toMatch(/Internal Pricing Guide|five criteria/i);
  });
});
