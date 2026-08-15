const AVATAR_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isSafeAvatarDataUrl(value: string | null): value is string {
  return value != null && AVATAR_DATA_URL.test(value);
}

export function avatarInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : parts[0]?.[0] ?? "?")
    .toLocaleUpperCase("ru-RU");
}
