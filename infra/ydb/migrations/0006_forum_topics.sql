CREATE TABLE workspace_topics (
  workspace_id Utf8 NOT NULL,
  message_thread_id Int64 NOT NULL,
  name Utf8,
  is_closed Bool,
  unavailable_reason Utf8,
  name_update_id Uint64,
  name_message_date Uint64,
  status_update_id Uint64,
  status_message_date Uint64,
  updated_at Timestamp,
  PRIMARY KEY (workspace_id, message_thread_id)
);

ALTER TABLE reminders ADD COLUMN message_thread_id Int64;
ALTER TABLE reminder_occurrences ADD COLUMN message_thread_id Int64;
ALTER TABLE notification_deliveries ADD COLUMN message_thread_id Int64;
