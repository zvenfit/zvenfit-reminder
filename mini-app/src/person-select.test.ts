import { describe, expect, it } from "vitest";
import { avatarInitials, isSafeAvatarDataUrl } from "./avatar-utils";

describe("participant selector", () => {
  it("builds compact Telegram-style monograms", () => {
    expect(avatarInitials("Анна")).toBe("А");
    expect(avatarInitials("Иван Петров")).toBe("ИП");
    expect(avatarInitials(" ")).toBe("?");
  });

  it("accepts only raster image data returned by the authenticated API", () => {
    expect(isSafeAvatarDataUrl("data:image/jpeg;base64,AQID")).toBe(true);
    expect(isSafeAvatarDataUrl("data:image/png;base64,AQID")).toBe(true);
    expect(isSafeAvatarDataUrl("data:image/svg+xml;base64,AQID")).toBe(false);
    expect(isSafeAvatarDataUrl("https://example.com/avatar.jpg")).toBe(false);
  });
});
