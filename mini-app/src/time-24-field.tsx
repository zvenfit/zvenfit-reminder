import { useEffect, useState } from "react";

const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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

interface Time24FieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
}

export function Time24Field({ label, value, onChange, required = false }: Time24FieldProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <span className="time-24-control">
      <input
        aria-label={label}
        autoComplete="off"
        inputMode="numeric"
        maxLength={5}
        pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]"
        placeholder="00:00"
        required={required}
        title="Введите время в формате ЧЧ:ММ от 00:00 до 23:59"
        type="text"
        value={draft}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => {
          if (!isLocalTime24(draft)) {
            setDraft(value);
          }
        }}
        onChange={(event) => {
          const next = formatTimeDraft(event.target.value);
          setDraft(next);
          if (isLocalTime24(next)) {
            onChange(next);
          }
        }}
      />
      <b aria-hidden="true">24 ч</b>
    </span>
  );
}
