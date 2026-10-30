# Current architecture and engineering notes

This document describes the reminder runtime checked into the repository.
Product behavior and design decisions are detailed in
[product-spec.md](product-spec.md) and [ux-design.md](ux-design.md); calendar
subscriptions remain a later phase from [target-architecture.md](target-architecture.md).

## What the system does

`zvenfit-reminder` manages personal and group reminders in multiple Telegram
groups. Each group is an isolated workspace with its own members, roles,
settings, reminders, occurrences, deliveries, and history. A Telegram Mini App
provides the main UI; a timer-backed Cloud Function sends and repeats due
notifications until a participant explicitly completes or snoozes them.

## Runtime topology

```text
Telegram updates ──> Cloudflare Worker ────> bot-webhook function
                                              ├─ bot commands/callbacks
Mini App ──────────> API Gateway /api/* ──────┤
                                              └─ workspace/reminder/member API

Cloud Timer (5m) ────────────────────────────> reminder-cron function
                                                     │
                                                     ├─> Cloudflare Worker /telegram/*
                                                     └─> YDB

bot-webhook function ──> Cloudflare Worker /telegram/* ──> Telegram Bot API
          └──────────────────────────────────────────────> YDB
```

The Telegram webhook uses a narrow Cloudflare Worker proxy because Telegram
connections to the Yandex API Gateway and direct function domains time out
intermittently in production. The Worker forwards only signed JSON updates to
the fixed public function origin. The function still verifies Telegram's
configured secret header before parsing an update. Mini App API traffic remains
behind API Gateway and verified init data.
Telegram API calls are time-bounded. If an update cannot be processed, the
webhook returns a Bot API method in its HTTP response so Telegram itself can
show a generic retry message or callback alert without another outbound request.
The response never exposes exception details or configuration values.
Production Bot API calls from both functions use the Worker's authenticated,
method-allowlisted `/telegram/*` route because direct Yandex Function egress to
Telegram is intermittent even when forced to IPv4. The bot token is sent only in
an encrypted function-to-Worker request header and is never part of the public
Worker URL. Local development keeps direct Bot API access with IPv4 preference.
Participant avatars are fetched lazily through authenticated Mini App API calls.
The function verifies both actor and target membership, requests the smallest
available Telegram profile photo, and returns a bounded raster data URL. The bot
token and Telegram file URL never reach the browser; unavailable photos fall
back to deterministic monograms.

The Mini App is built as static files and uploaded to Yandex Object Storage.
Both functions bundle application code with esbuild and install the YDB runtime
dependencies into their deployment directories.

## Main flows

### Bot and member cache

The bot resolves every Telegram group through `telegram_chat_workspaces`;
unregistered groups enter through the UI group selector; `/setup` remains a fallback.
Occurrence callbacks and `/start` are also accepted in private chats and then
authorized through workspace membership and role. Every observed
sender in a registered group is upserted into `users` and that workspace's
`workspace_members` model.
Telegram does not provide an API for listing every group member. Owners and
organizers therefore publish a workspace-scoped self-enrollment button in the
target group. Each click is matched to that chat and verified with
`getChatMember` before the sender is saved. Manual sync remains a fallback for
admins, cached users, and the requesting user. Join/leave updates
activate or remove membership. Removing an assignee pauses their reminders and
stops pending deliveries until an owner or organizer reassigns them.

### Forum topics and app entry

A reminder may select a registered topic in its workspace. `messageThreadId` is
nullable: null keeps ordinary-chat / General delivery, while private reminders
must have no topic. The topic is snapshotted into each occurrence and delivery;
initial messages, repeats and watcher escalation use that same destination.
`beginSend` compares the reserved chat and topic with the current occurrence and
requires a known open topic. An unavailable topic never falls back to General.
Telegram edits/deletes continue to address the original message by chat and ID.
Moving the destination retires the old message through the existing fenced
refresh queue before the next send. Reservation and the final send check both
wait while retirement still owns the old message IDs; a failed retirement keeps
its retry state and does not advance the notification cadence. Occurrence-only
edits leave the series alone.

`workspace_topics` is scoped by workspace and populated from authenticated
Telegram messages and topic create/rename/close/reopen service messages. A missing
name gets a visible topic-number fallback. Name and availability have independent
Telegram event watermarks (message date, then update ID), so a delayed close is not
lost after a newer rename. Ordinary activity changes neither known names nor
availability. `/topic Name` remains a fallback from inside the actual topic.
The command rechecks active workspace, chat binding and manager membership inside
the catalog transaction; its earlier role lookup is only for immediate feedback.

The UI uses `POST /api/topic-connections` with an actor/workspace-scoped UUID,
Telegram link and list label. The saved immutable operation is claimed in a short
transaction before external calls. The server checks only the authenticated
workspace's `getChat` result and sends one quiet service message to the candidate
thread, without mentions. Registration requires the returned chat, thread ID and
`is_topic_message` to match. The catalog write and successful operation result are
atomic and recheck active workspace, chat binding and manager rights. The former
unverified `POST /api/topics` write endpoint is removed; GET remains the catalog.
Telegram cannot enumerate forum topics; `requestChat` selects groups, not topics.
A link or successful `sendChatAction` alone is not topic verification.

Topic operations transition `pending → sending → succeeded / failed / unknown`.
Replaying a UUID cannot publish a second probe, and changed payloads conflict.
GET is read-only; an expired send lease is displayed as unknown, never resent.
The initiating actor can recover a lost response with the probe's confirmation
callback in the matching chat and thread; membership is checked before completion
and the callback bypasses generic membership observation. A late error cannot
overwrite successful callback recovery. Explicit new checks use a new UUID.
The claim persists `verification_started_at`, which survives callback recovery.
Registration uses this evidence time, never response arrival time, for catalog
freshness. It cannot clear a failure recorded at the same or a newer time, and it
cannot hide a newer send failure that arrives later. Legacy operations without
evidence do not advance that watermark or clear unavailable state. Absent operation
errors are stored as NULL.

Known closed/deleted-topic send errors mark the catalog destination unavailable
and are shown in the editor. A newer verification or metadata update wins over a
late failure. Dispatch never falls back to General. Successful retire-only message
sync detaches the old message IDs; history remains in notification deliveries.

### Group connection and app entry

The empty state and group settings expose the same group connector. New Telegram
clients use `requestChat` with an actor-bound `savePreparedKeyboardButton` and a
native group selector; other clients open an opaque, signed private-chat link and
a temporary “Выбрать группу” request-chat keyboard. Neither flow requires typing a
command. Ordinary groups and forums are both supported. A Mini App launch alone
does not mark the user's private chat available.

Group operations live in separate `group_connections` tables. A per-actor counter
never reuses Telegram `request_id`; the first selected chat is frozen before any
remote validation. Fresh `getChat` and `getChatMember` calls verify the group and
actor/bot administrator rights. A short completion transaction compares the saved
membership/workspace snapshot, then creates the workspace or explicitly reenrolls
the actor using the existing membership policy. A departed organizer returns as a
member, the current recorded owner remains owner, and paused reminders stay paused.
Connection never takes over another owner's workspace or reactivates a closed one.
No bulk member enumeration is required. HTTP calls never run inside a YDB transaction.

`POST /api/group-connections/:id/retry` resumes validation of the saved selection;
GET only reads status. This matters because failed webhook processing is acknowledged
with HTTP 200 and cannot depend on Telegram redelivery. All connection reads/retries
are creator-bound and expire after fifteen minutes.

Bot initialization configures the default persistent bottom “Напоминания” menu;
private entry restores the chat-specific menu too. `/start`, `/menu`, `/app` and
group buttons provide additional entry points. Groups use `startapp` when `getMe`
reports `has_main_web_app`, otherwise the private-chat start link. Both carry a
workspace navigation hint, matched only against authenticated memberships. Menu
configuration failure leaves an honest inline-button fallback and is retried.
Main Mini App setup in BotFather remains required for direct `startapp` links.

The Mini App stores versioned, expiring reminder drafts on the device, keyed by
actor, workspace and edited entity. Both series/current-occurrence scopes, raw
incomplete date/time input and pending topic checks survive a return from Telegram.
Restoration waits for authorized workspace/object loading and never autosaves to
the server. Confirmed saves clear drafts before dashboard reload. Async connector
results retain their original workspace and cannot change another form's destination.

### Mini App API

Requests carry `X-Telegram-Init-Data`. The backend verifies Telegram's HMAC and
a 24-hour maximum age. `GET /api/workspaces` lists active memberships; group connection endpoints are
actor-scoped so first-time users can connect a group. Other endpoints require `X-Workspace-Id` and repeat membership and role
authorization for that workspace. A development-only bypass requires both
`SKIP_INIT_DATA_VALIDATION=1` and exactly `NODE_ENV=development`.

### Reminder dispatch

Every five minutes the cron function lists all active workspaces and processes
each independently: finalizes expired undo windows, materializes due
occurrences, reserves due deliveries, sends Telegram messages, and persists the
result. A failure in one workspace or one candidate does not stop the others.

Local recurrence intent is calculated in the reminder's IANA timezone. Monthly
days beyond the end of a month resolve to that month's final day. A runtime slot
and a `(workspace_id, reminder_id, due_at)` occurrence slot prevent concurrent
timers from materializing the same obligation twice. Delivery keys are
deterministic. Their reservation transaction acquires the occurrence lease
before advancing the notification cadence. A second transaction immediately
before the external call compares a monotonic occurrence revision, revalidates
the destination, and refreshes the short lease until the result is recorded.
Reassign, edit, pause, complete, snooze, undo, and member removal return a
transient conflict while that lease is active.

State changes that affect an existing Telegram message enter a revision-fenced
refresh queue. A unique short lease serializes the external edit with reminder
mutations, so an older worker cannot overwrite a newer state. When visibility
or a private recipient changes, the old message is only retired with generic
text; current private content is sent separately to the new destination.
Immediate edits initiated by Telegram callbacks or the Mini App claim the same
revision-fenced queue instead of writing to Telegram outside this ordering.

Completion stops notification delivery and leaves a short undo window. Its
finalizer advances the runtime first, then keeps the expired item in a retry
queue until Telegram has removed the Undo button; only then is the queue marker
cleared. The completion snapshot retains the actor's Telegram identity and the
completion time for every later render. Snooze moves the next notification
forward. A recurring reminder does not materialize its next occurrence while
the current one is incomplete.

## Data model

- `workspaces` and `telegram_chat_workspaces`: one isolated workspace per
  registered Telegram group.
- `users` and `workspace_members`: Telegram identity plus group-scoped role,
  membership status, and an optional workspace-local display-name override.
- `reminders`, `reminder_watchers`, and `reminder_runtime`: reminder definition,
  observers, and current scheduling slot.
- `reminder_occurrences` and `reminder_occurrence_slots`: actionable instances
  and their uniqueness guard.
- `notification_deliveries`: deterministic delivery reservations and results.
- `audit_events`: workspace-scoped history.
- `workspace_topics`: observed or verified group destinations and availability.
- `topic_connection_requests`: immutable probe operations, separate from reminder delivery cadence.
- `group_connections`, `group_connection_requests`, `group_connection_counters`: actor-bound onboarding and non-reused Telegram selection IDs.

The complete greenfield schema is the first migration in
`infra/ydb/migrations`; `scripts/apply-ydb-migrations.sh`
records their versions and checksums in `schema_migrations`. Production deploys
apply outstanding migrations after tests and before updating functions. An
already recorded migration with a changed checksum aborts the deploy.
Migration `0002_workspace_member_display_name.sql` adds the nullable local-name
column without rewriting existing memberships; a missing value continues to
resolve to the current Telegram profile name.
Migrations `0003_reminder_kind.sql` and `0004_occurrence_kind.sql` add the
nullable `kind` discriminator to reminder definitions and occurrences.
Existing rows resolve to `payment` when they already contain an amount and to
`task` otherwise; all new writes persist the explicit kind.
Migration `0005_occurrence_lead_minutes.sql` adds a nullable snapshot of the
requested notification lead to occurrences. Existing rows intentionally keep a
`NULL` value because their stored first-notification timestamp may already have
been shifted by quiet hours and cannot be reversed safely. Newly materialized
occurrences and edits with an explicit numeric lead persist the exact requested
value.
For a legacy row, occurrence-only PATCH accepts `leadMinutes: null` only while
the deadline and timezone remain unchanged; this preserves its existing first
notification, sequence, and snooze state. Changing the deadline requires an
explicit numeric lead instead of guessing from a quiet-hours-adjusted timestamp.

Migration `0006_forum_topics.sql` creates `workspace_topics` and adds nullable
`message_thread_id` columns to reminders, occurrences, and deliveries. Apply it
through the migration ledger before deploying the new functions. Existing rows
remain in the default chat/General destination; there is no data rewrite. Omitted
PATCH destinations preserve the stored topic, while explicit null clears it.
Migration `0007_group_connections.sql` adds nullable `workspaces.is_forum` and the
group connection tables; existing groups refresh forum metadata from trusted group
updates or UI reconnection. Migration `0008_topic_connections.sql` adds the probe
operation table, including nullable `verification_started_at` for probe ordering.
Apply all three through the ledger before the new runtime. These
are additive migrations; existing reminder destinations and roles are unchanged.
Retain group request counters/mappings when cleaning expired operations, so old
Telegram selections cannot bind to a newer request.
Deploy the Worker allowlist for `getChat`, `savePreparedKeyboardButton`,
`setChatMenuButton` and `setMyCommands` before enabling these flows. No new function,
queue, scheduled consumer or API Gateway route is required.

## Build and deployment

- CI runs on Node.js 22, matching the supported Yandex Cloud Functions runtime:
  install, typecheck, test, build.
- A push to `main` applies outstanding YDB migrations, deploys both functions,
  verifies `getMe` and `sendMessage` access from inside the bot function runtime,
  uploads the Mini App, and resets the Telegram webhook.
- Function deploy directories are pruned to the runtime-only YDB dependency
  surface, and CI rejects archives above 3.4 MB before direct upload.
- The deploy job validates all required `production` secrets before changing
  cloud resources. Both functions receive the configured runtime service
  account.
- Infrastructure resources use the `zvenfit-reminder-` prefix. Existing
  installations created with the former `payments-reminder-` prefix are not
  renamed in place by these scripts; provision or migrate them deliberately
  before the first deployment under the new name.

## Known risks and gaps

1. Telegram cannot enumerate all group members. Automatic join and activity
   observation cover normal use, while a workspace-scoped group button lets
   missing participants enroll themselves after `getChatMember` verification.
2. A workspace owner can transfer ownership to an active member. If the owner
   leaves first, another Telegram administrator can recover ownership with
   `/setup`; the repository allows recovery only while the old owner is inactive.
3. A Telegram send whose result cannot be classified is stored as `unknown`.
   The dispatcher prefers a missed repeat over duplicate spam; operational
   reconciliation for unknown deliveries is still manual.
4. Repository and service behavior is unit-tested; Mini App journeys use Playwright
   with an isolated HTTP mock. Read queries and onboarding write transactions
   (including concurrent topic claims, revoked authorization and destination
   retirement) have opt-in integration tests against isolated loopback YDB.
   Full application write-path integration coverage remains a follow-up.
5. There is no configured linter or formatter.
6. Runtime, timer/API-Gateway invocation, and deployment use separate service
   accounts with resource-scoped bindings. The bot function additionally has a
   public invoke binding for Telegram's direct webhook; the handler requires the
   secret Telegram header. CI still installs the Yandex Cloud CLI through an
   unpinned `curl | bash` script; pinning and checksum verification remain an
   infrastructure hardening task.

## Verification baseline

Run `npm run check` before handing changes off. It covers typechecking, unit
tests, and every production build. Node.js 22 is the CI and production runtime
compatibility baseline.

The baseline is updated with each change through CI; do not rely on historical
test counts in this document.
