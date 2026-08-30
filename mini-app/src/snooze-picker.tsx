import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  ReminderOccurrence,
  SnoozeSelection,
  Workspace,
} from "./api";
import {
  buildCustomSnoozeDraft,
  buildSnoozePresetOptions,
  formatSnoozeDeadline,
  snoozeQuietHoursHint,
} from "./snooze-options";
import { describeTimezone } from "./timezones";
import { Time24Field } from "./time-24-field";
import { UiIcon } from "./ui-icon";
import { CalendarDateField } from "./calendar-date-field";

export function SnoozePicker({
  occurrence,
  workspace,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  occurrence: ReminderOccurrence;
  workspace: Workspace;
  pending: boolean;
  error: string | null;
  onConfirm(selection: SnoozeSelection): void;
  onClose(): void;
}) {
  const [now, setNow] = useState(() => new Date());
  const initialDraft = useMemo(
    () => buildCustomSnoozeDraft(now, occurrence.timezone),
    [now, occurrence.timezone],
  );
  const options = useMemo(() => buildSnoozePresetOptions({
    now,
    timezone: occurrence.timezone,
    morningTime: workspace.defaultAllDayReminderTime,
  }), [now, occurrence.timezone, workspace.defaultAllDayReminderTime]);
  const timezone = describeTimezone(occurrence.timezone, now);
  const deadline = formatSnoozeDeadline(occurrence);
  const quietHoursHint = snoozeQuietHoursHint({
    ignoreQuietHours: occurrence.ignoreQuietHours,
    quietHoursStart: workspace.quietHoursStart,
    quietHoursEnd: workspace.quietHoursEnd,
  });
  const dialogRef = useRef<HTMLElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [localDate, setLocalDate] = useState(initialDraft.localDate);
  const [localTime, setLocalTime] = useState(initialDraft.localTime);
  const [timingError, setTimingError] = useState<string | null>(null);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstActionRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const backButton = window.Telegram?.WebApp?.BackButton;
    if (!backButton) return;
    const handleBack = () => {
      if (!pending) onClose();
    };
    backButton.show();
    backButton.onClick(handleBack);
    return () => {
      backButton.offClick(handleBack);
      backButton.hide();
    };
  }, [onClose, pending]);

  useEffect(() => {
    if (pending) dialogRef.current?.focus();
  }, [pending]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)",
    ) ?? []);
    if (controls.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const currentIndex = controls.indexOf(document.activeElement as HTMLElement);
    const nextIndex = currentIndex < 0
      ? event.shiftKey ? controls.length - 1 : 0
      : event.shiftKey
        ? (currentIndex - 1 + controls.length) % controls.length
        : (currentIndex + 1) % controls.length;
    event.preventDefault();
    controls[nextIndex]?.focus();
  }

  return (
    <div
      className="snooze-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!pending && event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="snooze-picker"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={pending}
        aria-labelledby="snooze-picker-title"
        aria-describedby="snooze-picker-context snooze-picker-hint"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="snooze-picker__header">
          <span className="snooze-picker__mark" aria-hidden="true"><UiIcon name="clock" /></span>
          <div>
            <p className="eyebrow">Следующий сигнал</p>
            <h2 id="snooze-picker-title">Напомнить позже</h2>
          </div>
          <button
            className="snooze-picker__close"
            type="button"
            aria-label="Закрыть выбор времени"
            disabled={pending}
            onClick={onClose}
          >
            Закрыть
          </button>
        </header>

        <p className="snooze-picker__context" id="snooze-picker-context">
          «{occurrence.title}» · {timezone
            ? `${timezone.city} · ${timezone.offset}`
            : occurrence.timezone}
        </p>

        <div className="snooze-picker__presets" role="group" aria-label="Быстрый выбор времени">
          {options.map((option, index) => (
            <button
              className="snooze-picker__preset"
              ref={index === 0 ? firstActionRef : undefined}
              type="button"
              disabled={pending}
              key={option.preset}
              onClick={() => {
                const freshNow = new Date();
                const freshOption = buildSnoozePresetOptions({
                  now: freshNow,
                  timezone: occurrence.timezone,
                  morningTime: workspace.defaultAllDayReminderTime,
                }).find((candidate) => candidate.preset === option.preset);
                setNow(freshNow);
                if (
                  !freshOption ||
                  (option.preset !== "one_hour" &&
                    freshOption.previewLocalDate !== option.previewLocalDate)
                ) {
                  setTimingError("Время изменилось. Выберите подходящий вариант ещё раз.");
                  return;
                }
                setTimingError(null);
                onConfirm(option.selection);
              }}
            >
              <span><b>{option.title}</b><small>{option.absoluteLabel}</small></span>
              <UiIcon name="arrow-right" />
            </button>
          ))}
        </div>

        <button
          className="snooze-picker__custom-toggle"
          type="button"
          aria-expanded={customOpen}
          disabled={pending}
          onClick={() => {
            setTimingError(null);
            setCustomOpen((current) => !current);
          }}
        >
          <span><b>Выбрать дату и время</b><small>До 30 дней вперёд</small></span>
          <UiIcon name="chevron-down" />
        </button>

        {customOpen ? (
          <form
            className="snooze-picker__custom"
            onSubmit={(event) => {
              event.preventDefault();
              setTimingError(null);
              onConfirm({ type: "custom", localDate, localTime });
            }}
          >
            <div className="field">
              <label htmlFor="snooze-custom-date">Дата</label>
              <CalendarDateField
                id="snooze-custom-date"
                label="Дата"
                required
                min={initialDraft.minDate}
                max={initialDraft.maxDate}
                disabled={pending}
                value={localDate}
                onChange={setLocalDate}
              />
            </div>
            <label className="field">
              <span>Время</span>
              <Time24Field
                label="Время следующего сигнала"
                required
                disabled={pending}
                value={localTime}
                onChange={setLocalTime}
              />
            </label>
            <button className="primary-action" type="submit" disabled={pending || !localDate || !localTime}>
              {pending ? "Откладываю…" : "Напомнить в это время"}
            </button>
          </form>
        ) : null}

        {error || timingError ? (
          <div className="snooze-picker__error" role="alert">{error ?? timingError}</div>
        ) : null}
        {pending ? <div className="snooze-picker__pending" role="status">Сохраняем новое время…</div> : null}
        <p className="snooze-picker__hint" id="snooze-picker-hint">
          <span>После сохранения покажем точное время следующего сигнала.</span>
          <span>{quietHoursHint}</span>
          <strong>Срок не изменится: {deadline}.</strong>
        </p>
      </section>
    </div>
  );
}
