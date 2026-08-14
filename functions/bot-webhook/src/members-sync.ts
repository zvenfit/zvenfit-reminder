import type { Api, RawApi } from "grammy";

export interface SyncedTelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface SyncedTelegramMembership {
  status: string;
  is_member?: boolean;
  user: SyncedTelegramUser;
}

export function isOutsideGroup(member: SyncedTelegramMembership): boolean {
  return member.status === "left" ||
    member.status === "kicked" ||
    (member.status === "restricted" && member.is_member === false);
}

async function upsertTelegramUser(
  user: SyncedTelegramUser,
  onObservedUser: (user: SyncedTelegramUser) => Promise<void>,
): Promise<boolean> {
  if (user.is_bot) {
    return false;
  }

  await onObservedUser(user);
  return true;
}

export async function syncGroupMembers(
  api: Api<RawApi>,
  chatId: number,
  knownUserIds: number[],
  onObservedUser: (user: SyncedTelegramUser) => Promise<void>,
  currentUserId?: number,
  onRemovedUser?: (userId: number) => Promise<void>,
): Promise<number> {
  const seen = new Set<number>();
  let synced = 0;

  const admins = await api.getChatAdministrators(chatId);
  for (const member of admins) {
    if (seen.has(member.user.id)) {
      continue;
    }
    seen.add(member.user.id);
    if (await upsertTelegramUser(member.user, onObservedUser)) {
      synced += 1;
    }
  }

  for (const knownUserId of knownUserIds) {
    if (seen.has(knownUserId)) {
      continue;
    }

    try {
      const member = await api.getChatMember(chatId, knownUserId);
      if (isOutsideGroup(member)) {
        await onRemovedUser?.(knownUserId);
        continue;
      }
      seen.add(knownUserId);
      if (await upsertTelegramUser(member.user, onObservedUser)) {
        synced += 1;
      }
    } catch {
      // Member may have left the group.
    }
  }

  if (currentUserId != null && !seen.has(currentUserId)) {
    try {
      const member = await api.getChatMember(chatId, currentUserId);
      if (!isOutsideGroup(member)) {
        if (await upsertTelegramUser(member.user, onObservedUser)) {
          synced += 1;
        }
      } else {
        await onRemovedUser?.(currentUserId);
      }
    } catch {
      // Current user may be unavailable for lookup.
    }
  }

  return synced;
}
