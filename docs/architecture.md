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
unregistered groups can only use `/setup`.
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

### Mini App API

Requests carry `X-Telegram-Init-Data`. The backend verifies Telegram's HMAC and
a 24-hour maximum age. `GET /api/workspaces` lists active memberships; all other
endpoints require `X-Workspace-Id` and repeat membership and role
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
4. Repository and service behavior is unit-tested, and Mini App user journeys
   are covered by Playwright against an isolated HTTP mock. There are no YDB
   integration tests yet.
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
