import {
  UsersRepository,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  type AppConfig,
} from "@zvenfit-reminder/shared";

export interface ObservedTelegramUser {
  id: number;
  isBot?: boolean;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
}

export interface TelegramObservationDependencies {
  users: Pick<UsersRepository, "observe">;
  workspaces: Pick<WorkspacesRepository, "getByTelegramChatId">;
  members: Pick<WorkspaceMembersRepository, "observe">;
}

function createDependencies(config: AppConfig): TelegramObservationDependencies {
  return {
    users: new UsersRepository(config.ydbEndpoint, config.ydbDatabase),
    workspaces: new WorkspacesRepository(config.ydbEndpoint, config.ydbDatabase),
    members: new WorkspaceMembersRepository(config.ydbEndpoint, config.ydbDatabase),
  };
}

export async function observeTelegramIdentity(
  config: AppConfig,
  user: ObservedTelegramUser,
  chat: { id: number; type: "private" | "group" },
  providedDependencies?: TelegramObservationDependencies,
): Promise<void> {
  if (user.isBot) {
    return;
  }
  const dependencies = providedDependencies ?? createDependencies(config);
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "User";
  await dependencies.users.observe({
    userId: user.id,
    username: user.username ?? null,
    displayName,
    locale: user.languageCode ?? null,
    privateChatId: chat.type === "private" ? chat.id : null,
  });

  if (chat.type !== "group") {
    return;
  }
  const workspace = await dependencies.workspaces.getByTelegramChatId(chat.id);
  if (workspace?.status === "active") {
    await dependencies.members.observe(workspace.workspaceId, user.id);
  }
}
