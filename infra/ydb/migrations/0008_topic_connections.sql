CREATE TABLE topic_connection_requests (
  connection_id Utf8 NOT NULL,
  workspace_id Utf8 NOT NULL,
  actor_user_id Int64 NOT NULL,
  client_request_id Utf8 NOT NULL,
  telegram_chat_id Int64 NOT NULL,
  message_thread_id Int64 NOT NULL,
  link Utf8 NOT NULL,
  name Utf8 NOT NULL,
  state Utf8 NOT NULL,
  error_code Utf8,
  expires_at Timestamp NOT NULL,
  send_deadline Timestamp NOT NULL,
  verification_started_at Timestamp,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (connection_id)
);
