-- Resolve a private-message callback to its workspace without scanning occurrences.
ALTER TABLE reminder_occurrences
  ADD INDEX idx_occurrences_id GLOBAL
  ON (occurrence_id);
