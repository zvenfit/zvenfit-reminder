import {
  TELEGRAM_BOT_TOKEN_HEADER,
  TELEGRAM_PROXY_SECRET_HEADER,
  normalizeTelegramProxyRoot,
  type AppConfig,
} from "@zvenfit-reminder/shared";
import { Bot } from "grammy";
import { telegramClientOptions } from "./telegram-network.js";

const TELEGRAM_API_TIMEOUT_SECONDS = 5;
const TELEGRAM_FILE_TIMEOUT_MS = 5_000;
export const MAX_MEMBER_AVATAR_BYTES = 512 * 1024;

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface MemberAvatarDependencies {
  getUserProfilePhotos(userId: number): Promise<{ photos: TelegramPhotoSize[][] }>;
  getFile(fileId: string): Promise<{ file_path?: string }>;
  download(filePath: string): Promise<Response>;
}

export interface MemberAvatarLoader {
  load(userId: number): Promise<string | null>;
}

function smallestPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  return [...sizes].sort((left, right) =>
    left.width * left.height - right.width * right.height)[0];
}

export async function loadMemberAvatar(
  userId: number,
  dependencies: MemberAvatarDependencies,
): Promise<string | null> {
  const profilePhotos = await dependencies.getUserProfilePhotos(userId);
  const photo = smallestPhoto(profilePhotos.photos[0] ?? []);
  if (!photo || (photo.file_size != null && photo.file_size > MAX_MEMBER_AVATAR_BYTES)) {
    return null;
  }

  const file = await dependencies.getFile(photo.file_id);
  if (!file.file_path) return null;

  const response = await dependencies.download(file.file_path);
  if (!response.ok) throw new Error("Telegram avatar download failed");

  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw new Error("Telegram avatar has an unsupported content type");
  }

  const declaredSize = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_MEMBER_AVATAR_BYTES) {
    throw new Error("Telegram avatar is too large");
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_MEMBER_AVATAR_BYTES) {
    throw new Error("Telegram avatar is too large");
  }
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function telegramFileRequest(config: AppConfig, filePath: string): Request {
  if (config.telegramApiRoot && config.telegramProxySecret) {
    const apiRoot = new URL(normalizeTelegramProxyRoot(config.telegramApiRoot));
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    apiRoot.pathname = `/telegram-file/${encodedPath}`;
    return new Request(apiRoot, {
      headers: {
        [TELEGRAM_PROXY_SECRET_HEADER]: config.telegramProxySecret,
        [TELEGRAM_BOT_TOKEN_HEADER]: config.botToken,
      },
      signal: AbortSignal.timeout(TELEGRAM_FILE_TIMEOUT_MS),
    });
  }

  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return new Request(
    `https://api.telegram.org/file/bot${config.botToken}/${encodedPath}`,
    { signal: AbortSignal.timeout(TELEGRAM_FILE_TIMEOUT_MS) },
  );
}

export function createMemberAvatarLoader(config: AppConfig): MemberAvatarLoader {
  const bot = new Bot(config.botToken, {
    client: telegramClientOptions(TELEGRAM_API_TIMEOUT_SECONDS, config),
  });
  return {
    load: (userId) => loadMemberAvatar(userId, {
      getUserProfilePhotos: (targetUserId) =>
        bot.api.getUserProfilePhotos(targetUserId, { limit: 1 }),
      getFile: (fileId) => bot.api.getFile(fileId),
      download: (filePath) => fetch(telegramFileRequest(config, filePath)),
    }),
  };
}
