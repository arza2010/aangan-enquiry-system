import { describe, expect, it } from "vitest";
import { hasPriceLeak, redactPrices } from "@/lib/ai/priceGuard";

describe("price guard", () => {
  it.each([
    "Budget is ₹12 lakh",
    "caller wants it under 30 lakh",
    "quoted Rs 2,200 per sq ft",
    "about 2200 rupees a foot",
    "rate per sq ft was discussed",
    "budget 1.5 crore",
    "around 25 lacs",
    "1,500 INR",
    "has 15L to spend",
  ])("flags: %s", (t) => expect(hasPriceLeak(t)).toBe(true));

  it.each([
    "Caller has a 3BHK in Aundh, about 1,100 sq ft carpet. Wants kitchen, wardrobes and living room redone.",
    "Referral from Shruti Joshi. Wants to finish by March. Husband is aware and supportive.",
    "Possession in six weeks; builder allows site access now. Caller shared a budget (see budget field).",
  ])("allows: %s", (t) => expect(hasPriceLeak(t)).toBe(false));

  it("redaction leaves no leaks", () => {
    const out = redactPrices("Budget ₹12-15 lakh, they heard 2,200 per sq ft and 3 crore ideas");
    expect(hasPriceLeak(out)).toBe(false);
  });
});
