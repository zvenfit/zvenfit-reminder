-- Materialize occurrences from the first notification instant, not only from the deadline.
ALTER TABLE reminder_runtime ADD COLUMN next_reminder_start_at Timestamp;
