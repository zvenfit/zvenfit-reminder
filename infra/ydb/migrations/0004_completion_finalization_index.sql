-- Completed occurrences keep the runtime slot until their undo window expires.
ALTER TABLE reminder_occurrences
  ADD INDEX idx_occurrences_completion_finalize GLOBAL
  ON (status, undo_until, workspace_id)
  COVER (reminder_id);
