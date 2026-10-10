import { describe, expect, it } from "vitest";
import { viewerMode } from "@/lib/auth";

describe("who sees the app", () => {
  it("staff always get full powers", () => {
    expect(viewerMode({ loggedInStaff: true, publicDemo: false })).toBe("staff");
    expect(viewerMode({ loggedInStaff: true, publicDemo: true })).toBe("staff");
  });
  it("visitors are sent to login unless the public demo is switched on", () => {
    expect(viewerMode({ loggedInStaff: false, publicDemo: false })).toBe("login");
    expect(viewerMode({ loggedInStaff: false, publicDemo: true })).toBe("readonly");
  });
});
