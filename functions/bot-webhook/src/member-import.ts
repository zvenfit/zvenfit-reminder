export const MEMBER_IMPORT_REQUEST_ID = 0x5a56454e;

export interface SharedTelegramUser {
  user_id: number;
}

export interface ImportableChatMember {
  status: string;
  is_member?: boolean;
  user: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
}

export interface MemberImportDependencies {
  getChatMember(chatId: number, userId: number): Promise<ImportableChatMember>;
  saveMember(member: ImportableChatMember): Promise<void>;
}

export interface MemberImportResult {
  imported: number;
  skipped: number;
}

export function canImportWorkspaceMembers(member: {
  role: string;
  status: string;
} | null): boolean {
  return member?.status === "active" &&
    (member.role === "owner" || member.role === "organizer");
}

export async function importSharedGroupMembers(
  chatId: number,
  sharedUsers: SharedTelegramUser[],
  dependencies: MemberImportDependencies,
): Promise<MemberImportResult> {
  const uniqueUserIds = [...new Set(
    sharedUsers
      .map((user) => user.user_id)
      .filter((userId) => Number.isSafeInteger(userId) && userId > 0),
  )].slice(0, 10);

  const results = await Promise.all(uniqueUserIds.map(async (userId) => {
    try {
      const member = await dependencies.getChatMember(chatId, userId);
      if (
        member.user.is_bot ||
        member.status === "left" ||
        member.status === "kicked" ||
        (member.status === "restricted" && member.is_member !== true)
      ) {
        return false;
      }
      await dependencies.saveMember(member);
      return true;
    } catch {
      return false;
    }
  }));

  const imported = results.filter(Boolean).length;
  return {
    imported,
    skipped: uniqueUserIds.length - imported,
  };
}
