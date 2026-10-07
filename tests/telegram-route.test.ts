import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn(async () => ({ message_id: 1 }));
vi.mock("@/lib/telegram", async (orig) => ({ ...(await orig<typeof import("@/lib/telegram")>()), telegramClient: () => ({ send, answerCallback: vi.fn(), editMessage: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));

import { POST } from "@/app/api/telegram/route";

const req = (body: unknown, secret = "s3cret") =>
  new Request("https://app.test/api/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body) });

beforeEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
  send.mockClear();
});

describe("telegram webhook", () => {
  it("rejects calls without the secret token", async () => {
    expect((await POST(req({}, "wrong"))).status).toBe(401);
  });
  it("/start replies with the chat id (designers use this to tell the front desk their id)", async () => {
    const r = await POST(req({ message: { chat: { id: 100200300, type: "private" }, text: "/start" } }));
    expect(r.status).toBe(200);
    expect(send).toHaveBeenCalledWith("100200300", expect.stringContaining("100200300"));
  });
  it("also answers /start@botname in a group, and /id", async () => {
    await POST(req({ message: { chat: { id: -400500600 }, text: "/start@Facilitator_Vaani_bot" } }));
    await POST(req({ message: { chat: { id: 5 }, text: "/id" } }));
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("ignores ordinary chatter", async () => {
    await POST(req({ message: { chat: { id: 5 }, text: "hello there" } }));
    expect(send).not.toHaveBeenCalled();
  });
});
