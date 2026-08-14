-- Complete greenfield schema for the multi-workspace reminder product.

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id Utf8 NOT NULL,
  telegram_chat_id Int64 NOT NULL,
  display_name Utf8 NOT NULL,
  owner_user_id Int64 NOT NULL,
  timezone Utf8 NOT NULL,
  quiet_hours_start Utf8 NOT NULL,
  quiet_hours_end Utf8 NOT NULL,
  default_all_day_reminder_time Utf8 NOT NULL,
  status Utf8 NOT NULL,
  created_at Timestamp NOT NULL,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (workspace_id)
);

-- The primary key makes one Telegram chat map to at most one workspace.
CREATE TABLE IF NOT EXISTS telegram_chat_workspaces (
  telegram_chat_id Int64 NOT NULL,
  workspace_id Utf8 NOT NULL,
  created_at Timestamp NOT NULL,
  PRIMARY KEY (telegram_chat_id)
);

CREATE TABLE IF NOT EXISTS users (
  user_id Int64 NOT NULL,
  username Utf8,
  display_name Utf8 NOT NULL,
  private_chat_available Bool NOT NULL,
  private_chat_id Int64,
  locale Utf8,
  created_at Timestamp NOT NULL,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id Utf8 NOT NULL,
  user_id Int64 NOT NULL,
  role Utf8 NOT NULL,
  status Utf8 NOT NULL,
  role_granted_by Int64,
  role_granted_at Timestamp,
  last_observed_at Timestamp NOT NULL,
  created_at Timestamp NOT NULL,
  updated_at Timestamp NOT NULL,
  INDEX idx_workspace_members_user GLOBAL ON (user_id, status) COVER (role),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  workspace_id Utf8 NOT NULL,
  reminder_id Utf8 NOT NULL,
  title Utf8 NOT NULL,
  description Utf8,
  action_url Utf8,
  amount_minor Int64,
  currency Utf8,
  visibility Utf8 NOT NULL,
  creator_user_id Int64 NOT NULL,
  assignment_mode Utf8 NOT NULL,
  responsible_user_id Int64,
  schedule_spec JsonDocument NOT NULL,
  timezone Utf8 NOT NULL,
  lead_minutes Uint32 NOT NULL,
  repeat_interval_minutes Uint32 NOT NULL,
  ignore_quiet_hours Bool NOT NULL,
  escalation_enabled Bool NOT NULL,
  escalation_delay_minutes Uint32,
  escalation_repeat_minutes Uint32,
  status Utf8 NOT NULL,
  version Uint64 NOT NULL,
  created_at Timestamp NOT NULL,
  updated_at Timestamp NOT NULL,
  INDEX idx_reminders_creator GLOBAL ON (workspace_id, creator_user_id, status),
  PRIMARY KEY (workspace_id, reminder_id)
);

CREATE TABLE IF NOT EXISTS reminder_watchers (
  workspace_id Utf8 NOT NULL,
  reminder_id Utf8 NOT NULL,
  user_id Int64 NOT NULL,
  created_at Timestamp NOT NULL,
  PRIMARY KEY (workspace_id, reminder_id, user_id)
);

CREATE TABLE IF NOT EXISTS reminder_runtime (
  workspace_id Utf8 NOT NULL,
  reminder_id Utf8 NOT NULL,
  state Utf8 NOT NULL,
  next_due_at Timestamp,
  next_reminder_start_at Timestamp,
  current_occurrence_id Utf8,
  schedule_version Uint64 NOT NULL,
  updated_at Timestamp NOT NULL,
  INDEX idx_reminder_runtime_due GLOBAL ON (state, next_due_at, workspace_id)
    COVER (schedule_version),
  INDEX idx_reminder_runtime_start GLOBAL ON (state, next_reminder_start_at, workspace_id)
    COVER (next_due_at, schedule_version),
  PRIMARY KEY (workspace_id, reminder_id)
);

CREATE TABLE IF NOT EXISTS reminder_occurrences (
  workspace_id Utf8 NOT NULL,
  occurrence_id Utf8 NOT NULL,
  reminder_id Utf8 NOT NULL,
  reminder_version Uint64 NOT NULL,
  due_at Timestamp NOT NULL,
  due_local_date Utf8 NOT NULL,
  all_day Bool NOT NULL,
  reminder_start_at Timestamp NOT NULL,
  status Utf8 NOT NULL,
  notification_state Utf8 NOT NULL,
  assignment_mode Utf8 NOT NULL,
  responsible_user_id Int64,
  title Utf8 NOT NULL,
  description Utf8,
  action_url Utf8,
  amount_minor Int64,
  currency Utf8,
  visibility Utf8 NOT NULL,
  timezone Utf8 NOT NULL,
  repeat_interval_minutes Uint32 NOT NULL,
  ignore_quiet_hours Bool NOT NULL,
  escalation_enabled Bool NOT NULL,
  escalation_delay_minutes Uint32,
  escalation_repeat_minutes Uint32,
  watcher_user_ids JsonDocument NOT NULL,
  next_notification_at Timestamp,
  notification_sequence Uint32 NOT NULL,
  snoozed_by Int64,
  snoozed_at Timestamp,
  snooze_until Timestamp,
  latest_message_chat_id Int64,
  latest_message_id Int64,
  message_sync_required Bool NOT NULL,
  message_sync_retire_only Bool NOT NULL,
  state_revision Uint64 NOT NULL,
  delivery_lock_key Utf8,
  delivery_locked_at Timestamp,
  completed_by Int64,
  completed_by_display_name Utf8,
  completed_at Timestamp,
  undo_until Timestamp,
  completion_finalized_at Timestamp,
  cancelled_by Int64,
  cancellation_reason Utf8,
  cancelled_at Timestamp,
  created_at Timestamp NOT NULL,
  updated_at Timestamp NOT NULL,
  INDEX idx_occurrences_dispatch GLOBAL ON (notification_state, next_notification_at, workspace_id)
    COVER (reminder_id),
  INDEX idx_occurrences_plan GLOBAL ON (workspace_id, due_at)
    COVER (reminder_id, status, visibility, responsible_user_id),
  INDEX idx_occurrences_completion_finalize GLOBAL ON (status, undo_until, workspace_id)
    COVER (reminder_id),
  INDEX idx_occurrences_message_sync GLOBAL ON (message_sync_required, workspace_id)
    COVER (state_revision),
  INDEX idx_occurrences_id GLOBAL ON (occurrence_id),
  PRIMARY KEY (workspace_id, occurrence_id)
);

-- Inserted atomically with an occurrence. Its primary key is the portable unique
-- constraint for one occurrence per reminder and due instant.
CREATE TABLE IF NOT EXISTS reminder_occurrence_slots (
  workspace_id Utf8 NOT NULL,
  reminder_id Utf8 NOT NULL,
  due_at Timestamp NOT NULL,
  occurrence_id Utf8 NOT NULL,
  created_at Timestamp NOT NULL,
  PRIMARY KEY (workspace_id, reminder_id, due_at)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  workspace_id Utf8 NOT NULL,
  delivery_key Utf8 NOT NULL,
  occurrence_id Utf8 NOT NULL,
  reminder_id Utf8 NOT NULL,
  delivery_type Utf8 NOT NULL,
  sequence Uint32 NOT NULL,
  scheduled_at Timestamp NOT NULL,
  claimed_at Timestamp NOT NULL,
  occurrence_revision Uint64 NOT NULL,
  status Utf8 NOT NULL,
  telegram_chat_id Int64,
  telegram_message_id Int64,
  error_code Utf8,
  created_at Timestamp NOT NULL,
  updated_at Timestamp NOT NULL,
  INDEX idx_deliveries_diagnostics GLOBAL ASYNC ON (status, created_at, workspace_id)
    COVER (occurrence_id, reminder_id),
  PRIMARY KEY (workspace_id, delivery_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  workspace_id Utf8 NOT NULL,
  entity_id Utf8 NOT NULL,
  occurred_at Timestamp NOT NULL,
  event_id Utf8 NOT NULL,
  entity_type Utf8 NOT NULL,
  event_type Utf8 NOT NULL,
  actor_user_id Int64 NOT NULL,
  payload JsonDocument NOT NULL,
  INDEX idx_audit_workspace_time GLOBAL ON (workspace_id, occurred_at)
    COVER (entity_type, event_type, actor_user_id),
  PRIMARY KEY (workspace_id, entity_id, occurred_at, event_id)
);

-- The presented feed token is hashed before lookup. Making the hash the primary
-- key provides efficient authentication and global uniqueness without plaintext storage.
CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
  token_hash Utf8 NOT NULL,
  workspace_id Utf8 NOT NULL,
  user_id Int64 NOT NULL,
  token_id Utf8 NOT NULL,
  scope Utf8 NOT NULL,
  created_at Timestamp NOT NULL,
  last_used_at Timestamp,
  revoked_at Timestamp,
  INDEX idx_calendar_tokens_owner GLOBAL ON (workspace_id, user_id, created_at)
    COVER (token_id, scope, revoked_at),
  PRIMARY KEY (token_hash)
);
