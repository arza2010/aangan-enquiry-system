import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

/** In-memory stand-in for the slice of the Supabase query builder the app uses. Not a SQL engine: just enough to test flows. */
export function fakeDb(seed: Record<string, Row[]> = {}, opts: { unique?: Record<string, string[][]> } = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const unique = opts.unique ?? {
    notifications: [["dedupe_key"]],
    calls: [["channel", "external_id"]],
    leads: [["call_id"]],
    bookings: [["vaani_call_id", "slot_start"]],
  };
  const defaults: Record<string, () => Row> = {
    leads: () => ({ needs_review: false, missing_info: [], routed_at: null, accepted_at: null, hubspot_sync_status: "pending", hubspot_contact_id: null, hubspot_deal_id: null, call_type: "new_enquiry", assigned_designer_id: null, status: "new" }),
    notifications: () => ({ sent_at: null, cancelled_at: null, acted_at: null, attempts: 0, error: null, dedupe_key: null }),
    bookings: () => ({ status: "provisional" }),
  };

  class Q {
    private op: "select" | "insert" | "update" | "delete" = "select";
    private filters: Filter[] = [];
    private patch: Row = {};
    private inserted: Row[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    private mode: "many" | "single" | "maybe" = "many";
    private head = false;
    private wantCount = false;
    constructor(private table: string) {
      tables[table] ??= [];
    }
    select(_cols?: string, o?: { count?: string; head?: boolean }) {
      if (o?.count) this.wantCount = true;
      if (o?.head) this.head = true;
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.inserted = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...(defaults[this.table]?.() ?? {}), ...r }));
      return this;
    }
    update(p: Row) {
      this.op = "update";
      this.patch = p;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
    in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) < (v as string)); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) <= (v as string)); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) > (v as string)); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) >= (v as string)); return this; }
    order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending ?? true }; return this; }
    limit(n: number) { this.lim = n; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }

    private run() {
      const t = tables[this.table];
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        for (const row of this.inserted) {
          for (const cols of unique[this.table] ?? []) {
            if (cols.every((c) => row[c] != null) && t.some((x) => cols.every((c) => x[c] === row[c]))) {
              return { data: null, error: { code: "23505", message: `duplicate key on ${this.table}(${cols.join(",")})` } };
            }
          }
        }
        t.push(...this.inserted);
        return this.shape(this.inserted);
      }
      if (this.op === "update") {
        const hit = t.filter(match);
        hit.forEach((r) => Object.assign(r, this.patch, { updated_at: new Date().toISOString() }));
        return this.shape(hit);
      }
      if (this.op === "delete") {
        const keep = t.filter((r) => !match(r));
        const gone = t.length - keep.length;
        tables[this.table] = keep;
        return { data: null, error: null, count: gone };
      }
      let rows = t.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        rows = [...rows].sort((a, b) => ((a[col] as string) < (b[col] as string) ? -1 : (a[col] as string) > (b[col] as string) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.lim != null) rows = rows.slice(0, this.lim);
      if (this.head) return { data: null, error: null, count: rows.length };
      return this.shape(rows);
    }
    private shape(rows: Row[]) {
      const copy = rows.map((r) => ({ ...r }));
      const count = this.wantCount ? copy.length : undefined;
      if (this.mode === "single") return copy.length === 1 ? { data: copy[0], error: null, count } : { data: null, error: { message: `expected 1 row, got ${copy.length}` }, count };
      if (this.mode === "maybe") return { data: copy[0] ?? null, error: null, count };
      return { data: copy, error: null, count };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(ok?: (v: any) => unknown, bad?: (e: unknown) => unknown) {
      try {
        return Promise.resolve(this.run()).then(ok, bad);
      } catch (e) {
        return Promise.reject(e).then(ok, bad);
      }
    }
  }

  const db = { from: (t: string) => new Q(t) } as unknown as SupabaseClient;
  return { db, tables };
}

export const SETTINGS: Row[] = Object.entries({
  slot_min_lead_minutes: 30,
  slot_horizon_hours: 48,
  working_hours: { start: "10:00", end: "19:00" },
  working_days: [1, 2, 3, 4, 5, 6],
  sla_accept_minutes: 30,
  sla_after_hours_deadline: "10:30",
  reminder_after_minutes: 10,
  call_reminder_minutes: 15,
  quiet_hours: { start: "21:00", end: "08:00" },
  digest_time: "09:30",
  callback_promise_minutes: 60,
  after_hours_callback_time: "11:00",
  frontdesk_quiet_hours: false,
  project_value_range_lakh: { min: 8, max: 14 },
  price_sms_inr_per_message: 0.2,
  price_llm_inr_per_m_input: 100,
  price_llm_inr_per_m_output: 400,
  hubspot_pipeline_id: "default",
  hubspot_stage_map: { new: "s_new", sent_to_designer: "s_new", accepted: "s_acc", in_review: "s_new", contacted: "s_con", won: "s_won", lost: "s_lost" },
}).map(([key, value]) => ({ key, value }));
