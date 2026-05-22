import type { GroupMember, Rule } from "./types.js";

export function buildMentionHtml(mentionIds: number[], members: GroupMember[]): string {
  if (mentionIds.length === 0) {
    return "";
  }

  const memberMap = new Map(members.map((member) => [member.userId, member]));

  return mentionIds
    .map((userId) => {
      const member = memberMap.get(userId);
      const label = escapeHtml(member?.displayName ?? "User");
      return `<a href="tg://user?id=${userId}">${label}</a>`;
    })
    .join(" ");
}

export function buildReminderMessage(rule: Rule, members: GroupMember[]): string {
  const amountPart = rule.amount != null ? ` — ${(rule.amount / 100).toLocaleString("ru-RU")} ₽` : "";
  const mentions = buildMentionHtml(rule.mentionIds, members);
  const mentionPart = mentions ? `\n${mentions}` : "";
  return `🔔 <b>${escapeHtml(rule.title)}</b>${amountPart}\nНапоминание о платеже${mentionPart}`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function instanceCallbackData(action: "done" | "skip", instanceId: string): string {
  return `${action}:${instanceId}`;
}

export function parseInstanceCallbackData(data: string): { action: "done" | "skip"; instanceId: string } | null {
  const [action, instanceId] = data.split(":");
  if ((action !== "done" && action !== "skip") || !instanceId) {
    return null;
  }
  return { action, instanceId };
}
