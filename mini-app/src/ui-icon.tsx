export type UiIconName =
  | "arrow-right"
  | "calendar"
  | "check"
  | "chevron-down"
  | "clock"
  | "edit"
  | "group"
  | "history"
  | "location"
  | "members"
  | "once"
  | "payment"
  | "plus"
  | "private"
  | "refresh"
  | "repeat"
  | "search"
  | "target";

export function UiIcon({ name }: { name: UiIconName }) {
  return (
    <svg className="ui-icon" aria-hidden="true" viewBox="0 0 24 24">
      {name === "arrow-right" ? <><path d="M5 12h14" /><path d="m15 8 4 4-4 4" /></> : null}
      {name === "calendar" ? <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /><path d="M8 14h2M14 14h2" /></> : null}
      {name === "check" ? <path d="m5 12 4 4L19 6" /> : null}
      {name === "chevron-down" ? <path d="m7 9 5 5 5-5" /> : null}
      {name === "clock" ? <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></> : null}
      {name === "edit" ? <><path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></> : null}
      {name === "group" ? <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></> : null}
      {name === "history" ? <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" /><path d="M4 4v4.6h4.6M12 8v5l3 2" /></> : null}
      {name === "location" ? <><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></> : null}
      {name === "members" ? <><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" /><circle cx="10" cy="8" r="3" /><path d="M17 11a2.5 2.5 0 0 0 0-5M18 14.2a3.5 3.5 0 0 1 2 3.3V19" /></> : null}
      {name === "once" ? <><path d="M5 12h13" /><path d="m14 8 4 4-4 4" /></> : null}
      {name === "payment" ? <><path d="M8 19V5h5a4 4 0 0 1 0 8H8" /><path d="M6 16h8M6 19h8" /></> : null}
      {name === "plus" ? <path d="M12 5v14M5 12h14" /> : null}
      {name === "private" ? <><path d="M8 11V8a4 4 0 0 1 8 0v3" /><rect x="5" y="11" width="14" height="9" rx="2" /></> : null}
      {name === "refresh" ? <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 8a7 7 0 0 1 11.4-1.6L20 9M4 15l2.5 2.6A7 7 0 0 0 17.9 16" /></> : null}
      {name === "repeat" ? <><path d="m17 2 3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="m7 22-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></> : null}
      {name === "search" ? <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></> : null}
      {name === "target" ? <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2" /></> : null}
    </svg>
  );
}
