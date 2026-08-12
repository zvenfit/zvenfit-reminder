# Target architecture

Status: greenfield target for the redesign in
[product-spec.md](product-spec.md). The current prototype is documented in
[architecture.md](architecture.md).

## Principles

- Treat the existing payment-oriented schema as disposable.
- Keep reminder definitions separate from concrete occurrences.
- Scope every primary key, query, and authorization decision by workspace.
- Store local recurrence intent plus an IANA timezone; store computed instants
  as timestamps.
- Make database transitions atomic before calling external APIs.
- Prefer one skipped retry over duplicate spam when a Telegram result is
  ambiguous; later repeat intervals restore delivery.
- Preserve audit history and never silently rewrite completed occurrences.

## Runtime topology

```text
Telegram updates ──> API Gateway /webhook ──> bot-webhook function
                                              ├─ callback actions
Mini App ──────────> API Gateway /api/* ──────┤
                                              ├─ reminder/member APIs
ICS clients ───────> API Gateway /calendar/* ─┤
                                              └─ YDB

Cloud Timer ───────> reminder-cron function
                            ├─ materialize a due occurrence when needed
                            ├─ reserve due delivery and advance next time
                            ├─ send/edit/delete Telegram messages
                            └─ persist delivery result
```

The initial deployment may keep the existing two functions. A separate queue or
worker service is unnecessary at the expected family-group scale, provided the
dispatcher transition is transactionally claimed and concurrency-tested.

## Domain model

### `workspaces`

Primary key: `(workspace_id)`.

Important fields:

- Telegram chat ID, paired with a `telegram_chat_workspaces` primary-key row
  that enforces one workspace per chat;
- display name;
- owner user ID;
- IANA timezone;
- quiet-hour start and end local times, default `22:00` and `08:00`;
- default all-day reminder time, initially `09:00`;
- status and timestamps.

### `users`

Primary key: `(user_id)` using Telegram's 64-bit user ID.

Important fields:

- username and display name;
- private-chat availability and last private chat ID;
- locale;
- created and updated timestamps.

No bot token, init data, or authentication material is stored here.

### `workspace_members`

Primary key: `(workspace_id, user_id)`.

Important fields:

- role: `owner`, `organizer`, or `member`;
- membership status;
- role grant actor and timestamp;
- last observed timestamp.

### `reminders`

Primary key: `(workspace_id, reminder_id)`.

Important fields:

- title, description, and validated action URL;
- optional amount in minor units and ISO currency code;
- visibility: `group` or `private`;
- creator user ID;
- assignment mode: `person` or `anyone`;
- responsible user ID when assignment mode is `person`;
- `schedule_spec` as a versioned `JsonDocument` validated by a discriminated
  application schema;
- IANA timezone;
- reminder lead time and repeat interval;
- quiet-hour behavior;
- escalation delay and repeat interval;
- lifecycle status and optimistic version;
- created and updated timestamps.

The heterogeneous recurrence shape lives in versioned JSON because application
queries do not search inside it. Efficient dispatcher queries target computed
occurrence and delivery columns instead. Notification-policy values remain
explicit columns because the dispatcher reads and updates them frequently.

### `reminder_watchers`

Primary key: `(workspace_id, reminder_id, user_id)`.

The creator is inserted by default when assigning another person. Membership is
validated in the same transaction as reminder creation or update.

### `reminder_runtime`

Primary key: `(workspace_id, reminder_id)`.

Synchronous materialization index:
`(state, next_reminder_start_at, workspace_id)`.

This one-row-per-reminder table is the concurrency control point for recurrence:

- `state`: `ready`, `blocked`, or `paused`;
- next due and first-notification timestamps when ready;
- current occurrence ID when blocked;
- schedule version used to calculate the next deadline;
- updated timestamp.

Creation inserts the reminder, watcher rows, and runtime row together. A timer
may materialize an occurrence only after locking and reading this row in a
Serializable transaction. It inserts the occurrence and atomically moves the
runtime row from `ready` to `blocked` with that occurrence ID. This primary-key
slot, not a best-effort query for existing occurrences, guarantees at most one
incomplete occurrence per reminder.

### `reminder_occurrences`

Primary key: `(workspace_id, occurrence_id)`.

Uniqueness guard: a `reminder_occurrence_slots` row keyed by
`(workspace_id, reminder_id, due_at)` and inserted in the same transaction.

Synchronous dispatch index: `(notification_state, next_notification_at,
workspace_id)` covering the occurrence and reminder IDs.

Important fields:

- reminder ID and reminder version;
- due timestamp, local due date, all-day flag, and reminder-start timestamp;
- status: `scheduled`, `pending`, `overdue`, `completed`, or `cancelled`;
- notification state: `waiting` or `stopped`;
- assignment snapshot;
- content, timezone, and notification-policy snapshot;
- next notification timestamp and sequence;
- snooze actor and expiry;
- latest live Telegram chat/message IDs;
- completion actor and timestamp;
- undo deadline;
- cancellation actor, reason, and timestamp;
- creation and update timestamps.

The runtime row prevents more than one incomplete occurrence. The occurrence
slot primary key additionally prevents concurrent timers from creating the same
scheduled date twice without depending on secondary-index feature support.

The snapshot preserves historically accurate content after a series changes.

### `notification_deliveries`

Primary key: `(workspace_id, delivery_key)`.

An optional asynchronous operational index on `(status, created_at,
workspace_id)` supports diagnostics. Dispatch does not poll this table; it polls
the occurrence dispatch index and inserts a delivery reservation as part of the
claim transaction.

`delivery_key` is deterministic from occurrence ID, delivery type, scheduled
instant, and sequence. Fields include:

- occurrence and reminder IDs;
- type: initial, repeat, escalation, or state update;
- scheduled and claimed timestamps;
- status: reserved, sent, failed, or unknown;
- Telegram chat/message ID;
- sanitized error code and timestamps.

### `audit_events`

Primary key: `(workspace_id, entity_id, occurred_at, event_id)`.

This append-only log records creation, edits, role changes, snooze, completion,
completion on behalf of another person, undo, reopen, pause, resume, archive,
and cancellation. Event payloads contain non-secret structured diffs.

### `calendar_feed_tokens`

Primary key: `(token_hash)` with a synchronous owner index on
`(workspace_id, user_id, created_at)`.

Store only a cryptographic hash of the presented token, a public token ID, its
scope, creation and last-used timestamps, and revocation state. Hash lookup is
both globally unique and efficient. The plaintext token appears only in the
generated subscription URL.

### `schema_migrations`

Primary key: `(version)`.

Future schema changes are applied by ordered scripts and recorded explicitly.
YDB DDL is not assumed to roll back as one transaction.

## Scheduling

The scheduling library accepts a validated schedule specification, timezone,
and reference instant, and returns the next local occurrence as an absolute
timestamp.

Rules:

- local wall-clock intent survives timezone offset changes;
- monthly overflow resolves to the final day of the month;
- upcoming-date preview and backend calculation use the same shared function;
- paused dates are skipped rather than backfilled;
- a recurring reminder cannot materialize a new occurrence while an incomplete
  occurrence exists;
- one-off reminders archive after their occurrence completes or is cancelled.

Materialization scans `reminder_runtime` rows in `ready` state whose
`next_reminder_start_at` has arrived. This preserves long lead times without a
guesswork creation horizon. Completion marks the occurrence complete but keeps
the runtime slot blocked through the ten-minute undo window. A finalizer then
atomically clears the slot and calculates the first schedule date after `now`,
so a long-overdue monthly task completed on 27 September next appears on 25
October, not retroactively on 25 September. Undo simply reactivates the same
occurrence; no newly materialized occurrence needs to be cancelled.

The Plan and ICS views may calculate future dates without persisting future
occurrences. Persistence happens only for the current actionable occurrence.

## Notification reservation and delivery

For each due occurrence selected through the occurrence dispatch index, the
dispatcher performs this transaction before a Telegram call:

1. Read the occurrence in Serializable mode.
2. Confirm it is incomplete and `next_notification_at <= now`.
3. Insert the deterministic delivery row as `reserved`.
4. Advance `next_notification_at` to the next interval, adjusted for quiet
   hours, and increment the sequence.
5. Commit.

Only then does it call Telegram. On success it stores the message ID, removes or
compacts the previous live message, and marks the delivery `sent`. A definite
failure is `failed`; an ambiguous timeout is `unknown` and is not retried.

Advancing the next notification before the external call means a worker crash
can skip at most one ping but cannot stop the reminder chain or duplicate the
same scheduled attempt. This is deliberately at-most-once per ping because the
next repeat repairs a missed notification and duplicate group messages are more
disruptive.

YDB Serializable transactions provide the required read/write isolation, and
synchronous unique indexes can enforce unique occurrence keys. See
[YDB transactions](https://ydb.tech/docs/en/concepts/transactions) and
[YDB secondary indexes](https://ydb.tech/docs/en/concepts/query_execution/secondary_indexes).

## Telegram live-message behavior

- Send the new notification before removing the old one.
- Store every returned message ID in its delivery row.
- After success, delete the prior bot-authored message when allowed.
- If deletion fails or the message is too old, remove its keyboard and edit it
  to a compact superseded state.
- On snooze, edit the live message without generating a notification.
- On completion, edit the live message, remove ordinary action buttons, and add
  a ten-minute undo action.
- Callback handlers load the occurrence by workspace, validate the actor's role,
  and use idempotent state transitions.

Telegram currently permits bots to delete their own group messages less than
48 hours old and to edit their own text and inline keyboards. See the
[Telegram Bot API](https://core.telegram.org/bots/api#deletemessage).

## Authorization

Mini App requests continue to carry verified Telegram init data. Verification
proves the Telegram identity but is followed by application authorization:

1. Resolve the workspace from the configured chat or request route.
2. Require active `workspace_members` membership.
3. Apply the role and reminder-visibility rules.
4. Include `workspace_id` in every repository method and key predicate.

Owners and organizers can administer all group reminders. Private reminders
are intentionally different: only the creator and responsible person may read
or mutate them, regardless of another member's workspace role.

Telegram callbacks also resolve the callback actor and apply the same service
layer. Repository methods never update a reminder or occurrence by bare ID.

Private calendar feeds authenticate with the hashed revocable token rather than
Telegram init data.

## Target API surface

Representative endpoints:

```text
GET    /api/dashboard?scope=mine|all
GET    /api/plan?from=...&to=...
GET    /api/history?cursor=...

POST   /api/reminders
GET    /api/reminders/:id
PATCH  /api/reminders/:id?scope=current|series
POST   /api/reminders/:id/pause
POST   /api/reminders/:id/resume
POST   /api/reminders/:id/archive

POST   /api/occurrences/:id/complete
POST   /api/occurrences/:id/snooze
POST   /api/occurrences/:id/undo-completion
POST   /api/occurrences/:id/reopen

GET    /api/members
PATCH  /api/members/:userId/role
POST   /api/members/sync

POST   /api/calendar-feeds
DELETE /api/calendar-feeds/:tokenId
GET    /calendar/:token.ics
```

Create and update schemas enforce cross-field schedule, visibility, assignment,
timezone, currency, URL, and notification invariants. Domain validation lives in
shared code used by handlers, the Mini App preview, and tests.

## Calendar feeds

The ICS generator expands occurrences over a rolling window and emits stable
UIDs derived from workspace, reminder, and due instant. It exports deadlines,
not notification retries. Completed status may appear in the event description,
but feed refresh latency means it is informational only.

Tokenized URLs are bearer secrets. They are shown once, can be revoked, and must
never appear in logs. Google, Apple, and Yandex are the supported subscription
targets; Outlook is intentionally out of scope.

## Retention and privacy

- Reminder and occurrence history is retained until a future explicit workspace
  retention policy is introduced.
- Delivery diagnostics may use YDB TTL after a defined operational window;
  logical queries must not rely on exact TTL deletion time.
- Audit events retain no init data, bot tokens, secret calendar tokens, or full
  Telegram payloads.
- API errors and logs use sanitized provider error codes.

## Observability

Record structured metrics for:

- due occurrences materialized;
- deliveries reserved, sent, failed, and unknown;
- callbacks accepted, rejected, and idempotently ignored;
- duplicate-key prevention;
- snooze, completion, reopen, and escalation counts;
- cron duration and oldest overdue delivery lag.

Logs carry workspace and entity IDs but no secret values or private reminder
content unless explicitly needed for a local debug build.
