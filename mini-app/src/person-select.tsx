import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { getMemberAvatar, type WorkspaceMember } from "./api";
import { avatarInitials, isSafeAvatarDataUrl } from "./avatar-utils";

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
    void getMemberAvatar(member.userId).then((avatar) => {
      if (active && isSafeAvatarDataUrl(avatar)) setSource(avatar);
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
      <span>◎</span>
    </span>
  );
}

export function PersonSelect({
  members,
  value,
  actorId,
  includeAnyone,
  onChange,
}: {
  members: WorkspaceMember[];
  value: string;
  actorId?: number;
  includeAnyone: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
    if (event.key === "Escape") setOpen(false);
  }

  return (
    <div
      className={open ? "person-select is-open" : "person-select"}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        className="person-select__trigger"
        type="button"
        aria-label="Ответственный"
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
              : selectedMember?.username ? `@${selectedMember.username}` : "Участник группы"}</small>
        </span>
        <span className="person-select__chevron" aria-hidden="true">⌄</span>
      </button>

      {open ? (
        <div className="person-select__menu" role="listbox" aria-label="Участники группы">
          {includeAnyone ? (
            <button
              className={selectedAnyone ? "person-select__option is-selected" : "person-select__option"}
              type="button"
              role="option"
              aria-selected={selectedAnyone}
              onClick={() => choose("anyone")}
            >
              <AnyoneAvatar />
              <span><b>Может выполнить любой</b><small>Вся группа</small></span>
              {selectedAnyone ? <span className="person-select__check" aria-hidden="true">✓</span> : null}
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
                key={member.userId}
                onClick={() => choose(String(member.userId))}
              >
                <MemberAvatar member={member} />
                <span>
                  <b>{member.displayName}{member.userId === actorId ? " · вы" : ""}</b>
                  <small>{member.username ? `@${member.username}` : "Участник группы"}</small>
                </span>
                {selected ? <span className="person-select__check" aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
