export interface Rule {
  id: string;
  title: string;
  amount: number | null;
  ruleType: "recurring" | "oneoff";
  dayOfMonth: number | null;
  dueAt: string | null;
  timeLocal: string;
  timezone: string;
  chatId: number;
  mentionIds: number[];
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface GroupMember {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string;
  updatedAt: string;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

function getInitData(): string {
  return window.Telegram?.WebApp?.initData ?? "";
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": getInitData(),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export function listRules(): Promise<{ rules: Rule[] }> {
  return api("/api/rules");
}

export function listMembers(): Promise<{ members: GroupMember[] }> {
  return api("/api/members");
}

export function createRule(body: Record<string, unknown>): Promise<{ rule: Rule }> {
  return api("/api/rules", { method: "POST", body: JSON.stringify(body) });
}

export function updateRule(id: string, body: Record<string, unknown>): Promise<{ rule: Rule }> {
  return api(`/api/rules/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
}

export function deleteRule(id: string): Promise<{ ok: boolean }> {
  return api(`/api/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready: () => void;
        expand: () => void;
        themeParams: Record<string, string>;
        showAlert: (message: string) => void;
      };
    };
  }
}
