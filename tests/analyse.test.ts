import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { analyseCall } from "@/lib/pipeline/analyse";
import type { PostCallResult } from "@/lib/ai/postCall";

/** Tiny in-memory stand-in for the Supabase query builder, just enough for analyseCall. */
function fakeDb(call: Record<string, unknown>) {
  const tables: Record<string, Record<string, unknown>[]> = {
    calls: [call],
    leads: [],
    bookings: [],
    cost_events: [],
    settings: [{ key: "price_llm_inr_per_m_input", value: 100 }, { key: "price_llm_inr_per_m_output", value: 400 }],
  };
  const builder = (name: string) => {
    let rows = tables[name];
    let pendingInsert: Record<string, unknown> | null = null;
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), api),
      is: () => api,
      insert: (row: Record<string, unknown>) => {
        pendingInsert = { id: `${name}-${tables[name].length + 1}`, needs_review: false, classification: null, ...row };
        tables[name].push(pendingInsert);
        return api;
      },
      update: () => api,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: pendingInsert ?? rows[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res({ data: rows, error: null }),
    };
    return api;
  };
  return { db: { from: builder } as unknown as SupabaseClient, tables };
}

const call = { id: "c1", external_id: "v1", transcript: "Caller: hi", started_at: "2026-09-16T06:49:00Z" };
const base = {
  call_type: "new_enquiry", caller_name: "A", project_type: "home", location: "Baner", carpet_area_sqft: 900,
  bhk_or_rooms: "2BHK", scope: "full", budget_range: null, timeline: null, possession_status: "ready",
  source: null, language: "en", classification: "qualified", classification_reason: "ok.", missing_info: [],
  handoff_note: "Wants a full redesign.", price_mentioned_in_call: false,
} as const;
const usage = { input_tokens: 1000, output_tokens: 500 };
const ok = (over = {}): PostCallResult => ({ ok: true, data: { ...base, ...over } as never, usage, attempts: 1, flags: [], model: "test" });

describe("analyseCall never loses a call", () => {
  it("clean qualified lead goes on to routing and logs LLM cost", async () => {
    const { db, tables } = fakeDb(call);
    await analyseCall(db, "c1", async () => ok());
    expect(tables.leads[0].status).toBe("new");
    expect(tables.leads[0].needs_review).toBe(false);
    expect(tables.cost_events[0]).toMatchObject({ service: "llm", unit_type: "tokens" });
    expect(Number(tables.cost_events[0].cost_inr)).toBeCloseTo(0.1 + 0.2);
  });

  it("price mentioned → front desk review even if qualified", async () => {
    const { db, tables } = fakeDb(call);
    await analyseCall(db, "c1", async () => ok({ price_mentioned_in_call: true }));
    expect(tables.leads[0]).toMatchObject({ status: "in_review", needs_review: true });
    expect(String(tables.leads[0].review_reason)).toContain("price mentioned");
  });

  it("borderline / not qualified → review queue, not dropped", async () => {
    const { db, tables } = fakeDb(call);
    await analyseCall(db, "c1", async () => ok({ classification: "not_qualified" }));
    expect(tables.leads[0]).toMatchObject({ status: "in_review", needs_review: true, classification: "not_qualified" });
  });

  it("existing-client complaint is never auto-routed as a new lead", async () => {
    const { db, tables } = fakeDb(call);
    await analyseCall(db, "c1", async () => ok({ call_type: "existing_client", classification: "borderline" }));
    expect(tables.leads[0]).toMatchObject({ status: "in_review", needs_review: true });
  });

  it("invalid LLM output → needs_review lead", async () => {
    const { db, tables } = fakeDb(call);
    await analyseCall(db, "c1", async () => ({ ok: false, error: "bad json", usage, attempts: 2, rawText: "", model: "test" }));
    expect(tables.leads[0]).toMatchObject({ status: "in_review", needs_review: true });
    expect(String(tables.leads[0].review_reason)).toContain("extraction failed");
  });

  it("API outage → needs_review lead", async () => {
    const { db, tables } = fakeDb(call);
    await analyseCall(db, "c1", async () => { throw new Error("529 overloaded"); });
    expect(tables.leads[0]).toMatchObject({ status: "in_review", needs_review: true });
    expect(String(tables.leads[0].review_reason)).toContain("529");
  });

  it("is idempotent: a second run does not create a second lead", async () => {
    const { db, tables } = fakeDb(call);
    await analyseCall(db, "c1", async () => ok());
    await analyseCall(db, "c1", async () => ok());
    expect(tables.leads).toHaveLength(1);
  });
});
