import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cleanTranscript, inlinePhone, normaliseVaani, vaaniEventName, verifyWebhookToken, VaaniCallMetaSchema } from "@/lib/channels/vaani";
import { fetchVaaniCallMeta } from "@/lib/channels/vaaniApi";
import { toE164 } from "@/lib/phone";
import { isAfterHours } from "@/lib/hours";

const load = (f: string) => JSON.parse(readFileSync(`tests/fixtures/${f}`, "utf8"));
const webhook = load("vaani-call_postprocessing.json");
const history = load("vaani-call-history.json");
const meta = VaaniCallMetaSchema.parse(history.data[1]);

describe("vaani adapter", () => {
  it("only call_postprocessing is processed", () => {
    expect(vaaniEventName(webhook)).toBe("call_postprocessing");
    expect(vaaniEventName({ event: "call_ended", room_name: "x" })).toBe("call_ended");
  });

  it("maps webhook + call-history to NormalisedEnquiry", () => {
    const n = normaliseVaani(webhook, meta);
    expect(n.external_id).toBe("inbound-1784899978-36cec598");
    expect(n.caller_phone).toBe("+919876543210");
    expect(n.started_at).toBe("2026-09-16T06:49:00.123Z"); // naive history time treated as UTC
    expect(n.duration_sec).toBe(330); // webhook gives ms
    expect(n.provider_cost_credits).toBe(14.5);
    expect(n.transcript.split("\n")[0]).toBe("Agent: Hello, Aangan Studio. How can I help?");
    expect(n.transcript).toContain("Caller: Hi, I have a 3BHK in Aundh");
    expect(n.transcript).not.toMatch(/\[\d\d:/);
  });

  it("still stores the call when history lookup fails (number unknown, never lost)", () => {
    const n = normaliseVaani(webhook, null);
    expect(n.caller_phone).toBe("unknown");
    expect(n.duration_sec).toBe(330);
    expect(new Date(n.started_at).getTime()).toBe(new Date("2026-09-16T06:54:30.278Z").getTime() - 330000);
  });

  it("accepts fields at top level too (Vaani's docs show both layouts)", () => {
    const flat = { event: "call_postprocessing", call_id: "c1", timestamp: webhook.timestamp, call_duration: 60000, transcript: "[12:00:00] USER: hi" };
    const n = normaliseVaani(flat, meta);
    expect(n.duration_sec).toBe(60);
    expect(n.transcript).toBe("Caller: hi");
  });

  it("uses a caller number carried in the payload itself (test replays) when there is no call-history record", () => {
    const withPhone = { ...webhook, data: { ...webhook.data, from_number: "098765 43210" } };
    expect(normaliseVaani(withPhone, null).caller_phone).toBe("+919876543210");
    expect(inlinePhone(withPhone)).toBe("098765 43210");
    expect(inlinePhone(webhook)).toBeNull();
  });

  it("rejects a non-postprocessing payload", () => {
    expect(() => normaliseVaani({ event: "call_ended", room_name: "x" })).toThrow();
  });

  it("cleans transcript labels and timestamps", () => {
    expect(cleanTranscript("[13:33:14] AGENT: hi\n\n[13:33:19] USER: hello")).toBe("Agent: hi\nCaller: hello");
  });

  it("checks the webhook token in constant time and rejects wrong/missing", () => {
    expect(verifyWebhookToken("abc123", "abc123")).toBe(true);
    expect(verifyWebhookToken("abc124", "abc123")).toBe(false);
    expect(verifyWebhookToken("abc", "abc123")).toBe(false);
    expect(verifyWebhookToken(null, "abc123")).toBe(false);
  });
});

describe("vaani call-history lookup", () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("finds the call and sends the API key header", async () => {
    let seen: HeadersInit | undefined;
    const f = (async (_u: string, init?: RequestInit) => ((seen = init?.headers), new Response(JSON.stringify(history)))) as unknown as typeof fetch;
    const m = await fetchVaaniCallMeta("inbound-1784899978-36cec598", "k", { f });
    expect(m?.from_number).toBe("+919876543210");
    expect(seen).toEqual({ "X-API-Key": "k" });
  });

  it("returns null (never throws) when not found or the API is down", async () => {
    expect(await fetchVaaniCallMeta("nope", "k", { f: ok(history), retries: 1 })).toBeNull();
    const down = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchVaaniCallMeta("x", "k", { f: down, retries: 2, delayMs: 1 })).toBeNull();
    expect(await fetchVaaniCallMeta("x", undefined)).toBeNull();
  });

  it("checks the last page too, since sort order is undocumented", async () => {
    const pages: Record<string, unknown> = {
      "1": { data: [{ call_id: "a" }], pagination: { total_pages: 3 } },
      "3": { data: [{ call_id: "target", from_number: "+911234567890" }], pagination: { total_pages: 3 } },
    };
    const f = (async (u: string) => new Response(JSON.stringify(pages[new URL(u).searchParams.get("page")!] ?? { data: [] }))) as unknown as typeof fetch;
    expect((await fetchVaaniCallMeta("target", "k", { f, retries: 1 }))?.from_number).toBe("+911234567890");
  });
});

describe("helpers", () => {
  it("normalises phone numbers", () => {
    expect(toE164("98765 43210")).toBe("+919876543210");
    expect(toE164("09876543210")).toBe("+919876543210");
    expect(toE164("+91 98765-43210")).toBe("+919876543210");
  });
  it("detects after-hours in IST (not server time)", () => {
    expect(isAfterHours(new Date("2026-09-09T17:17:00Z"))).toBe(true); // 22:47 IST
    expect(isAfterHours(new Date("2026-09-16T06:49:00Z"))).toBe(false); // 12:19 IST
    expect(isAfterHours(new Date("2026-09-16T13:30:00Z"))).toBe(true); // 19:00 IST boundary
    expect(isAfterHours(new Date("2026-09-16T04:30:00Z"))).toBe(false); // 10:00 IST boundary
  });
});

describe("transcripts as real Vaani sends them", () => {
  it("handles single-newline turns and an untimestamped welcome line", () => {
    const raw = "AGENT: Hello, Aangan Studio, How can I help you today?\n[13:46:22] AGENT: Hello?\n[13:46:24] USER: I'd like to redo my\n[13:46:25] USER: apartment in three.";
    expect(cleanTranscript(raw)).toBe("Agent: Hello, Aangan Studio, How can I help you today?\nAgent: Hello?\nCaller: I'd like to redo my\nCaller: apartment in three.");
  });
});

describe("real Vaani payloads carry explicit nulls", () => {
  const real = {
    event: "call_postprocessing", call_id: "webrtc-1791-abc", timestamp: "2026-10-10T19:10:00+00:00",
    data: { room_name: "webrtc-1791-abc", call_id: "webrtc-1791-abc", call_duration: 41000, end_reason: "Call ended", summary: null, entities: null, dispositions: null, recording_url: null, transcript: "[19:09:20] AGENT: Hello, Aangan Studio.\n\n[19:09:25] USER: Hi, I want to redo my flat" },
  };
  it("accepts null entities / summary / dispositions / recording url", () => {
    const n = normaliseVaani(real, null);
    expect(n.external_id).toBe("webrtc-1791-abc");
    expect(n.duration_sec).toBe(41);
    expect(n.recording_url).toBeUndefined();
    expect(n.transcript).toContain("Caller: Hi, I want to redo my flat");
  });
  it("accepts a missing transcript and a missing data block", () => {
    expect(normaliseVaani({ ...real, data: { ...real.data, transcript: null } }, null).transcript).toBe("");
    expect(normaliseVaani({ event: "call_postprocessing", call_id: "x", timestamp: null, data: null }, null).transcript).toBe("");
  });
});
