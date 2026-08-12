-- Occurrence snapshots keep the reminder timezone used for quiet-hour scheduling.
ALTER TABLE reminder_occurrences ADD COLUMN timezone Utf8;
