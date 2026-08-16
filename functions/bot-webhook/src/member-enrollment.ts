import type { AppConfig } from "@zvenfit-reminder/shared";
import { Bot, InlineKeyboard } from "grammy";
import { telegramClientOptions } from "./telegram-network.js";

const TELEGRAM_API_TIMEOUT_SECONDS = 5;
const MEMBER_ENROLLMENT_PREFIX = "member_join:";

export interface MemberEnrollmentPublisher {
  publish(input: {
    workspaceId: string;
    telegramChatId: number;
    displayName: string;
  }): Promise<void>;
}

export interface TelegramGroupMembership {
  status: string;
  is_member?: boolean;
  user: {
    id: number;
    is_bot: boolean;
  };
}

export interface EnrollmentWorkspaceTarget {
  workspaceId: string;
  telegramChatId: number;
  status: string;
}

export function memberEnrollmentCallbackData(workspaceId: string): string {
  const data = `${MEMBER_ENROLLMENT_PREFIX}${workspaceId}`;
  if (data.length > 64) {
    throw new Error("Workspace ID is too long for Telegram callback data");
  }
  return data;
}

export function parseMemberEnrollmentCallbackData(data: string): string | null {
  if (!data.startsWith(MEMBER_ENROLLMENT_PREFIX)) return null;
  const workspaceId = data.slice(MEMBER_ENROLLMENT_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(workspaceId)
    ? workspaceId
    : null;
}

export function isActiveGroupMember(member: TelegramGroupMembership): boolean {
  return !member.user.is_bot &&
    member.status !== "left" &&
    member.status !== "kicked" &&
    !(member.status === "restricted" && member.is_member !== true);
}

export function isEnrollmentTarget(
  workspace: EnrollmentWorkspaceTarget | null,
  callbackWorkspaceId: string,
  callbackChatId: number,
): workspace is EnrollmentWorkspaceTarget {
  return workspace?.status === "active" &&
    workspace.workspaceId === callbackWorkspaceId &&
    workspace.telegramChatId === callbackChatId;
}

export function memberEnrollmentMessage(displayName: string): string {
  return [
    `👥 Подключение к планировщику «${displayName}»`,
    "",
    "Нажмите кнопку ниже, чтобы появиться в списке участников. Бот добавит только ваш аккаунт и проверит, что вы состоите в этой группе.",
  ].join("\n");
}

export function memberEnrollmentKeyboard(workspaceId: string): InlineKeyboard {
  return new InlineKeyboard().text(
    "Присоединиться к планировщику",
    memberEnrollmentCallbackData(workspaceId),
  );
}

export function createMemberEnrollmentPublisher(
  config: AppConfig,
): MemberEnrollmentPublisher {
  const bot = new Bot(config.botToken, {
    client: telegramClientOptions(TELEGRAM_API_TIMEOUT_SECONDS, config),
  });
  return {
    async publish({ workspaceId, telegramChatId, displayName }) {
      await bot.api.sendMessage(
        telegramChatId,
        memberEnrollmentMessage(displayName),
        { reply_markup: memberEnrollmentKeyboard(workspaceId) },
      );
    },
  };
}
