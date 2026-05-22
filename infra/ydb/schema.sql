-- Правила напоминаний (ежемесячные и разовые)
CREATE TABLE rules (
  id Utf8 NOT NULL,              -- UUID
  title Utf8 NOT NULL,           -- "Ипотека", "Коммуналка"
  amount Int64,                  -- сумма в копейках (опционально)
  rule_type Utf8 NOT NULL,       -- 'recurring' | 'oneoff'
  day_of_month Uint8,            -- 1-31, NULL для oneoff
  due_at Timestamp,              -- точная дата для oneoff
  time_local Utf8 NOT NULL,      -- "09:00"
  timezone Utf8 NOT NULL,        -- "Europe/Moscow"
  chat_id Int64 NOT NULL,        -- ID группы Telegram
  mention_ids JsonDocument NOT NULL, -- [user_id, ...]
  status Utf8 NOT NULL,          -- 'active' | 'paused' | 'archived'
  created_at Timestamp NOT NULL,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (id)
);

-- Срабатывания напоминаний (для отметки выполнения и истории)
CREATE TABLE reminder_instances (
  id Utf8 NOT NULL,
  rule_id Utf8 NOT NULL,
  due_at Timestamp NOT NULL,
  status Utf8 NOT NULL,          -- 'pending' | 'done' | 'skipped'
  completed_by Int64,
  completed_at Timestamp,
  message_id Int64,              -- ID сообщения Telegram для inline-кнопок
  PRIMARY KEY (id),
  INDEX idx_instances_status_due GLOBAL ON (status, due_at)
);

-- Кэш участников группы для выбора mention в Mini App
CREATE TABLE group_members (
  chat_id Int64 NOT NULL,
  user_id Int64 NOT NULL,
  username Utf8,
  display_name Utf8 NOT NULL,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
