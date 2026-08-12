import type { MembersRepository } from "@zvenfit-reminder/shared";
import type { Api, RawApi } from "grammy";

function memberDisplayName(user: {
  first_name: string;
  last_name?: string;
  username?: string;
}): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "User";
}

export interface SyncedTelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

async function upsertTelegramUser(
  membersRepo: MembersRepository,
  chatId: number,
  user: SyncedTelegramUser,
  onObservedUser?: (user: SyncedTelegramUser) => Promise<void>,
): Promise<boolean> {
  if (user.is_bot) {
    return false;
  }

  await membersRepo.upsert(chatId, user.id, user.username ?? null, memberDisplayName(user));
  await onObservedUser?.(user);
  return true;
}

export async function syncGroupMembers(
  api: Api<RawApi>,
  chatId: number,
  membersRepo: MembersRepository,
  currentUserId?: number,
  onObservedUser?: (user: SyncedTelegramUser) => Promise<void>,
): Promise<number> {
  const seen = new Set<number>();
  let synced = 0;

  const admins = await api.getChatAdministrators(chatId);
  for (const member of admins) {
    if (seen.has(member.user.id)) {
      continue;
    }
    seen.add(member.user.id);
    if (await upsertTelegramUser(membersRepo, chatId, member.user, onObservedUser)) {
      synced += 1;
    }
  }

  const cached = await membersRepo.list(chatId);
  for (const cachedMember of cached) {
    if (seen.has(cachedMember.userId)) {
      continue;
    }

    try {
      const member = await api.getChatMember(chatId, cachedMember.userId);
      if (member.status === "left" || member.status === "kicked") {
        continue;
      }
      seen.add(cachedMember.userId);
      if (await upsertTelegramUser(membersRepo, chatId, member.user, onObservedUser)) {
        synced += 1;
      }
    } catch {
      // Member may have left the group.
    }
  }

  if (currentUserId != null && !seen.has(currentUserId)) {
    try {
      const member = await api.getChatMember(chatId, currentUserId);
      if (member.status !== "left" && member.status !== "kicked") {
        if (await upsertTelegramUser(membersRepo, chatId, member.user, onObservedUser)) {
          synced += 1;
        }
      }
    } catch {
      // Current user may be unavailable for lookup.
    }
  }

  return synced;
}
