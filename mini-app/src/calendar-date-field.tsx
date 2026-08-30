import { useEffect, useId, useRef, useState } from "react";
import { UiIcon } from "./ui-icon";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DISPLAY_DATE_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const DEFAULT_EMPTY_MESSAGE = "Введите дату в формате ДД.ММ.ГГГГ.";

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1) return false;
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

export function formatCalendarDateValue(value: string): string {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return "";
  const [, year, month, day] = match;
  if (!isRealCalendarDate(Number(year), Number(month), Number(day))) return "";
  return `${day}.${month}.${year}`;
}

export function formatCalendarDateDraft(value: string): string {
  const storedValue = formatCalendarDateValue(value);
  if (storedValue) return storedValue;

  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

export function parseCalendarDateDraft(value: string): string | null {
  const match = DISPLAY_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, day, month, year] = match;
  if (!isRealCalendarDate(Number(year), Number(month), Number(day))) return null;
  return `${year}-${month}-${day}`;
}

export function validateCalendarDateDraft(
  value: string,
  {
    required = false,
    min,
    max,
    emptyMessage = DEFAULT_EMPTY_MESSAGE,
  }: {
    required?: boolean;
    min?: string;
    max?: string;
    emptyMessage?: string;
  } = {},
): string | null {
  if (!value) return required ? emptyMessage : null;
  if (!DISPLAY_DATE_PATTERN.test(value)) return DEFAULT_EMPTY_MESSAGE;

  const parsed = parseCalendarDateDraft(value);
  if (!parsed) return "Такой даты не существует.";
  if (min && parsed < min) {
    return `Выберите дату не раньше ${formatCalendarDateValue(min)}.`;
  }
  if (max && parsed > max) {
    return `Выберите дату не позже ${formatCalendarDateValue(max)}.`;
  }
  return null;
}

interface CalendarDateFieldProps {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  emptyMessage?: string;
  describedBy?: string;
  externalError?: string | null;
  errorId?: string;
}

export function CalendarDateField({
  id,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
  min,
  max,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  describedBy,
  externalError = null,
  errorId: providedErrorId,
}: CalendarDateFieldProps) {
  const [draft, setDraft] = useState(() => formatCalendarDateValue(value));
  const [showError, setShowError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedErrorId = `${useId()}-error`;
  const errorId = providedErrorId ?? generatedErrorId;
  const validationError = validateCalendarDateDraft(draft, {
    required,
    min,
    max,
    emptyMessage,
  });
  const localError = showError ? validationError : null;
  const displayedError = externalError ?? localError;

  useEffect(() => {
    const nextDraft = formatCalendarDateValue(value);
    setDraft(nextDraft);
    setShowError((current) => current && Boolean(validateCalendarDateDraft(nextDraft, {
      required,
      min,
      max,
      emptyMessage,
    })));
  }, [value]);

  useEffect(() => {
    inputRef.current?.setCustomValidity(validationError ?? "");
  }, [validationError]);

  function commitDraft(nextDraft: string) {
    const parsed = parseCalendarDateDraft(nextDraft);
    const nextError = validateCalendarDateDraft(nextDraft, {
      required,
      min,
      max,
      emptyMessage,
    });
    const keepErrorVisible = showError || Boolean(externalError);
    if (parsed) {
      onChange(parsed);
      setShowError(keepErrorVisible && Boolean(nextError));
    } else if (!nextDraft) {
      onChange("");
      setShowError(keepErrorVisible && Boolean(nextError));
    } else if (keepErrorVisible) {
      setShowError(Boolean(nextError));
    }
  }

  const ariaDescribedBy = [describedBy, displayedError ? errorId : null]
    .filter(Boolean).join(" ") || undefined;

  return (
    <>
      <span className="calendar-date-control">
        <input
          ref={inputRef}
          id={id}
          aria-describedby={ariaDescribedBy}
          aria-invalid={Boolean(displayedError) || undefined}
          aria-label={label}
          autoComplete="off"
          className="calendar-date-control__text"
          disabled={disabled}
          inputMode="numeric"
          maxLength={10}
          placeholder="ДД.ММ.ГГГГ"
          required={required}
          spellCheck={false}
          title="Введите дату в формате ДД.ММ.ГГГГ"
          type="text"
          value={draft}
          onBlur={() => setShowError(Boolean(validationError))}
          onChange={(event) => {
            const nextDraft = formatCalendarDateDraft(event.target.value);
            setDraft(nextDraft);
            commitDraft(nextDraft);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onInvalid={() => setShowError(Boolean(validationError))}
        />
        <span className="calendar-date-control__picker" aria-hidden="true">
          <UiIcon name="calendar" />
        </span>
        <input
          id={`${id}-native`}
          aria-describedby={ariaDescribedBy}
          aria-invalid={Boolean(displayedError) || undefined}
          aria-label={`Открыть календарь: ${label.toLocaleLowerCase("ru-RU")}`}
          className="calendar-date-control__native"
          disabled={disabled}
          max={max}
          min={min}
          type="date"
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setDraft(formatCalendarDateValue(nextValue));
            onChange(nextValue);
            setShowError(false);
          }}
        />
      </span>
      {displayedError ? <span className="field-error" id={errorId} role="alert">{displayedError}</span> : null}
    </>
  );
}
