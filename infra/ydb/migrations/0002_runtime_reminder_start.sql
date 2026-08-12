-- Materialize occurrences from the first notification instant, not only from the deadline.
ALTER TABLE reminder_runtime ADD COLUMN next_reminder_start_at Timestamp;

ALTER TABLE reminder_runtime
  ADD INDEX idx_reminder_runtime_start GLOBAL
  ON (state, next_reminder_start_at, workspace_id)
  COVER (next_due_at, schedule_version);
