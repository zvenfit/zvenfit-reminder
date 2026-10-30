-- Durable actor-bound UI group onboarding. Existing workspaces default to non-forum
-- until a trusted Telegram update or a successful group validation refreshes metadata.
ALTER TABLE workspaces ADD COLUMN is_forum Bool;

CREATE TABLE IF NOT EXISTS group_connections (
  connection_id Utf8 NOT NULL,
  payload Utf8 NOT NULL,
  PRIMARY KEY (connection_id)
);

-- Never expire/reuse per-actor request ids: late chat_shared updates must not bind to
-- a different connection. Retain counters and mappings when cleaning old operations.
CREATE TABLE IF NOT EXISTS group_connection_counters (
  actor_user_id Int64 NOT NULL,
  next_request_id Int64 NOT NULL,
  PRIMARY KEY (actor_user_id)
);
CREATE TABLE IF NOT EXISTS group_connection_requests (
  actor_user_id Int64 NOT NULL,
  request_id Int64 NOT NULL,
  connection_id Utf8 NOT NULL,
  PRIMARY KEY (actor_user_id, request_id)
);
