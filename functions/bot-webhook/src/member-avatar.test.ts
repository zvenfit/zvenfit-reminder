import { describe, expect, it, vi } from "vitest";
import {
  loadMemberAvatar,
  MAX_MEMBER_AVATAR_BYTES,
  telegramFileRequest,
} from "./member-avatar.js";

describe("member avatars", () => {
  it("loads the smallest Telegram profile photo as a private data URL", async () => {
    const dependencies = {
      getUserProfilePhotos: vi.fn().mockResolvedValue({
        photos: [[
          { file_id: "large", width: 640, height: 640, file_size: 100_000 },
          { file_id: "small", width: 160, height: 160, file_size: 3 },
        ]],
      }),
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/avatar.jpg" }),
      download: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/jpeg", "Content-Length": "3" },
      })),
    };

    await expect(loadMemberAvatar(42, dependencies)).resolves.toBe(
      "data:image/jpeg;base64,AQID",
    );
    expect(dependencies.getFile).toHaveBeenCalledWith("small");
    expect(dependencies.download).toHaveBeenCalledWith("photos/avatar.jpg");
  });

  it("uses a monogram fallback when Telegram has no profile photo", async () => {
    const dependencies = {
      getUserProfilePhotos: vi.fn().mockResolvedValue({ photos: [] }),
      getFile: vi.fn(),
      download: vi.fn(),
    };

    await expect(loadMemberAvatar(42, dependencies)).resolves.toBeNull();
    expect(dependencies.getFile).not.toHaveBeenCalled();
  });

  it("rejects oversized or non-image payloads", async () => {
    const base = {
      getUserProfilePhotos: vi.fn().mockResolvedValue({
        photos: [[{ file_id: "small", width: 160, height: 160 }]],
      }),
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/avatar.jpg" }),
    };
    const oversized = {
      ...base,
      download: vi.fn().mockResolvedValue(new Response(new Uint8Array(), {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(MAX_MEMBER_AVATAR_BYTES + 1),
        },
      })),
    };
    const html = {
      ...base,
      download: vi.fn().mockResolvedValue(new Response("not an image", {
        headers: { "Content-Type": "text/html" },
      })),
    };

    await expect(loadMemberAvatar(42, oversized)).rejects.toThrow("too large");
    await expect(loadMemberAvatar(42, html)).rejects.toThrow("content type");
  });

  it("keeps the bot token out of the proxy file URL", () => {
    const request = telegramFileRequest({
      ydbEndpoint: "grpc://unused",
      ydbDatabase: "/unused",
      botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_123",
      webhookSecret: "secret",
      defaultTimezone: "Europe/Moscow",
      miniAppUrl: "",
      telegramApiRoot: "https://reminder.example.workers.dev/telegram",
      telegramProxySecret: "proxy-secret",
    }, "photos/avatar 1.jpg");

    expect(request.url).toBe(
      "https://reminder.example.workers.dev/telegram-file/photos/avatar%201.jpg",
    );
    expect(request.url).not.toContain("123456:");
    expect(request.headers.get("X-Zvenfit-Telegram-Proxy-Secret")).toBe("proxy-secret");
    expect(request.headers.get("X-Zvenfit-Telegram-Bot-Token")).toContain("123456:");
  });
});
