import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { getMemberAvatar, type WorkspaceMember } from "./api";
import { avatarInitials, isSafeAvatarDataUrl } from "./avatar-utils";
import { UiIcon } from "./ui-icon";

function avatarHue(userId: number): CSSProperties {
  return { "--avatar-hue": String(Math.abs(userId * 47) % 360) } as CSSProperties;
}

export function MemberAvatar({ member, size = "regular" }: {
  member: WorkspaceMember;
  size?: "small" | "regular";
}) {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSource(null);
    void getMemberAvatar(member.userId).then((avatar) => {
      if (active) setSource(isSafeAvatarDataUrl(avatar) ? avatar : null);
    }).catch(() => {
      if (active) setSource(null);
    });
    return () => {
      active = false;
    };
  }, [member.userId]);

  return (
    <span
      className={`member-avatar member-avatar--${size}`}
      style={avatarHue(member.userId)}
      aria-hidden="true"
    >
      {source
        ? <img src={source} alt="" onError={() => setSource(null)} />
        : <span>{avatarInitials(member.displayName)}</span>}
    </span>
  );
}

function AnyoneAvatar({ size = "regular" }: { size?: "small" | "regular" }) {
  return (
    <span className={`member-avatar member-avatar--${size} member-avatar--anyone`} aria-hidden="true">
      <span><UiIcon name="target" /></span>
    </span>
  );
}

export function PersonSelect({
  members,
  value,
  actorId,
  includeAnyone,
  id,
  invalid = false,
  describedBy,
  onChange,
}: {
  members: WorkspaceMember[];
  value: string;
  actorId?: number;
  includeAnyone: boolean;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedMember = members.find((member) => String(member.userId) === value);
  const selectedAnyone = includeAnyone && value === "anyone";

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function choose(nextValue: string): void {
    onChange(nextValue);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => {
        const options = rootRef.current?.querySelectorAll<HTMLButtonElement>("button[role='option']");
        const target = event.key === "ArrowUp" ? options?.[options.length - 1] : options?.[0];
        target?.focus();
      });
    }
    if (event.key === "Escape") setOpen(false);
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>("button[role='option']");
    if (!current) return;
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='option']"));
    const index = options.indexOf(current);
    if (index < 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[nextIndex]?.focus();
  }

  return (
    <div
      className={open ? "person-select is-open" : "person-select"}
      ref={rootRef}
      onKeyDown={handleOptionKeyDown}
    >
      <button
        id={id}
        className="person-select__trigger"
        ref={triggerRef}
        type="button"
        aria-label="Ответственный"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        {selectedAnyone ? <AnyoneAvatar size="small" /> : selectedMember ? (
          <MemberAvatar member={selectedMember} size="small" />
        ) : (
          <span className="member-avatar member-avatar--small member-avatar--empty" aria-hidden="true">?</span>
        )}
        <span className="person-select__current">
          <b>{selectedAnyone
            ? "Может выполнить любой"
            : selectedMember?.displayName ?? "Выберите участника"}</b>
          <small>{selectedAnyone
            ? "Ответственный определится по факту"
            : selectedMember?.userId === actorId
              ? "Это вы"
              : selectedMember?.displayNameOverride
                ? `Telegram: ${selectedMember.telegramDisplayName}`
                : selectedMember?.username ? `@${selectedMember.username}` : "Участник группы"}</small>
        </span>
        <span className="person-select__chevron" aria-hidden="true"><UiIcon name="chevron-down" /></span>
      </button>

      {open ? (
        <div className="person-select__menu" role="listbox" aria-label="Участники группы">
          {includeAnyone ? (
            <button
              className={selectedAnyone ? "person-select__option is-selected" : "person-select__option"}
              type="button"
              role="option"
              aria-selected={selectedAnyone}
              tabIndex={selectedAnyone || !selectedMember ? 0 : -1}
              onClick={() => choose("anyone")}
            >
              <AnyoneAvatar />
              <span><b>Может выполнить любой</b><small>Вся группа</small></span>
              {selectedAnyone ? <span className="person-select__check" aria-hidden="true"><UiIcon name="check" /></span> : null}
            </button>
          ) : null}
          {members.map((member) => {
            const selected = String(member.userId) === value;
            return (
              <button
                className={selected ? "person-select__option is-selected" : "person-select__option"}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={selected || (!selectedAnyone && !selectedMember && member === members[0]) ? 0 : -1}
                key={member.userId}
                onClick={() => choose(String(member.userId))}
              >
                <MemberAvatar member={member} />
                <span>
                  <b>{member.displayName}{member.userId === actorId ? " · вы" : ""}</b>
                  <small>{member.displayNameOverride
                    ? `Telegram: ${member.telegramDisplayName}`
                    : member.username ? `@${member.username}` : "Участник группы"}</small>
                </span>
                {selected ? <span className="person-select__check" aria-hidden="true"><UiIcon name="check" /></span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
