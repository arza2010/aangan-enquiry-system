import { describe, expect, it } from "vitest";
import { periodsFor } from "@/lib/range";

const ist = (s: string) => new Date(`${s}+05:30`);

describe("dashboard periods (IST)", () => {
  it("default: this month so far vs the whole of last month", () => {
    const { current, previous } = periodsFor(ist("2026-10-07T15:00:00"));
    expect(current.from).toEqual(ist("2026-10-01T00:00:00"));
    expect(current.to).toEqual(ist("2026-10-08T00:00:00"));
    expect(current.days).toBe(7);
    expect(previous.from).toEqual(ist("2026-09-01T00:00:00"));
    expect(previous.to).toEqual(ist("2026-10-01T00:00:00"));
    expect(previous.days).toBe(30);
  });
  it("rolls over the year boundary", () => {
    const { previous } = periodsFor(ist("2026-01-05T10:00:00"));
    expect(previous.from).toEqual(ist("2025-12-01T00:00:00"));
  });
  it("custom range is inclusive and compared with the equally long range before it", () => {
    const { current, previous } = periodsFor(ist("2026-10-07T15:00:00"), "2026-09-10", "2026-09-19");
    expect(current.days).toBe(10);
    expect(previous.days).toBe(10);
    expect(previous.to).toEqual(current.from);
    expect(current.to).toEqual(ist("2026-09-20T00:00:00"));
  });
  it("rejects a backwards range", () => {
    expect(() => periodsFor(new Date(), "2026-09-20", "2026-09-10")).toThrow();
  });
  it("a late-evening IST time still counts as that IST day, not the next UTC day", () => {
    const { current } = periodsFor(new Date("2026-10-31T19:30:00Z")); // 1 Nov, 01:00 IST
    expect(current.from).toEqual(ist("2026-11-01T00:00:00"));
  });
});
