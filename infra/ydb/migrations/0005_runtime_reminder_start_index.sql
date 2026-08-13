-- Add the runtime lookup index after the reminder-start column exists.
ALTER TABLE reminder_runtime
  ADD INDEX idx_reminder_runtime_start GLOBAL
  ON (state, next_reminder_start_at, workspace_id)
  COVER (next_due_at, schedule_version);
