import { useEffect, useId, useState } from "react";

const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INVALID_TIME_MESSAGE = "Введите время от 00:00 до 23:59";

export function isLocalTime24(value: string): boolean {
  return LOCAL_TIME_PATTERN.test(value);
}

export function formatTimeDraft(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) {
    return digits;
  }
  if (digits.length === 3 && Number(digits.slice(0, 2)) > 23) {
    return `0${digits[0]}:${digits.slice(1)}`;
  }
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

interface TimeDraftChange {
  draft: string;
  error: string | null;
  committedValue: string | null;
}

export function resolveTimeDraftChange(value: string, showError: boolean): TimeDraftChange {
  const draft = formatTimeDraft(value);
  const valid = isLocalTime24(draft);

  return {
    draft,
    error: valid || !showError ? null : INVALID_TIME_MESSAGE,
    committedValue: valid ? draft : null,
  };
}

export function validateTimeDraft(draft: string): string | null {
  return isLocalTime24(draft) ? null : INVALID_TIME_MESSAGE;
}

interface Time24FieldProps {
  id?: string;
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
  disabled?: boolean;
}

export function Time24Field({
  id,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
}: Time24FieldProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const errorId = `${useId()}-error`;

  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  return (
    <>
      <span className="time-24-control">
        <input
          id={id}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          aria-label={label}
          autoComplete="off"
          inputMode="numeric"
          maxLength={5}
          pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]"
          placeholder="00:00"
          required={required}
          disabled={disabled}
          title="Введите время в формате ЧЧ:ММ от 00:00 до 23:59"
          type="text"
          value={draft}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => setError(validateTimeDraft(draft))}
          onInvalid={() => setError(validateTimeDraft(draft))}
          onChange={(event) => {
            const next = resolveTimeDraftChange(event.target.value, error !== null);
            setDraft(next.draft);
            setError(next.error);
            if (next.committedValue !== null) {
              onChange(next.committedValue);
            }
          }}
        />
        <b aria-hidden="true">24 ч</b>
      </span>
      {error ? <span className="field-error" id={errorId} role="alert">{error}</span> : null}
    </>
  );
}
