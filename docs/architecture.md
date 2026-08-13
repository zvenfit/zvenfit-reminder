# Current architecture and engineering notes

This document describes the universal reminder runtime checked into the
repository. Product behavior and design decisions are detailed in
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
Telegram updates ──> API Gateway /webhook ──> bot-webhook function
                                              ├─ bot commands/callbacks
Mini App ──────────> API Gateway /api/* ──────┤
                                              └─ workspace/reminder/member API

Cloud Timer (5m) ────────────────────────────> reminder-cron function
                                                     │
                                                     ├─> Telegram Bot API
                                                     └─> YDB

bot-webhook function ────────────────────────────────> YDB
```

The Mini App is built as static files and uploaded to Yandex Object Storage.
Both functions bundle application code with esbuild and install the YDB runtime
dependencies into their deployment directories.

## Main flows

### Bot and member cache

In universal mode, the bot resolves every Telegram group through
`telegram_chat_workspaces`; unregistered groups can only use `/setup`. Universal
callbacks, `/start`, and native user-picker results are also accepted in private
chats and then authorized through workspace membership and role. Every observed
sender in a registered group is upserted into `group_members` and that
workspace's member model.
Telegram does not provide an API for listing every group member. Owners and
organizers can therefore select up to ten users at a time in the private bot
chat; the backend verifies every selected ID with `getChatMember` against the
selected workspace's Telegram group before saving it. Manual sync remains a
fallback for admins, cached users, and the requesting user. Join/leave updates
activate or remove membership. Removing an assignee pauses their reminders and
stops pending deliveries until an owner or organizer reassigns them.

### Mini App API

Requests carry `X-Telegram-Init-Data`. The backend verifies Telegram's HMAC and
a 24-hour maximum age. `GET /api/workspaces` lists active memberships; all other
universal endpoints require `X-Workspace-Id` and repeat membership and role
authorization for that workspace. A development-only bypass requires both
`SKIP_INIT_DATA_VALIDATION=1` and a non-production `NODE_ENV`.

### Reminder dispatch

Every five minutes the cron function lists all active workspaces and processes
each independently: finalizes expired undo windows, materializes due
occurrences, reserves due deliveries, sends Telegram messages, and persists the
result. A failure in one workspace or one candidate does not stop the others.

Local recurrence intent is calculated in the reminder's IANA timezone. Monthly
days beyond the end of a month resolve to that month's final day. A runtime slot
and a `(workspace_id, reminder_id, due_at)` occurrence slot prevent concurrent
timers from materializing the same obligation twice. Delivery keys are
deterministic and reserved transactionally before Telegram is called.

Completion stops notification delivery and leaves a short undo window. Snooze
moves the next notification forward. A recurring reminder does not materialize
its next occurrence while the current one is incomplete.

## Data model

- `workspaces` and `telegram_chat_workspaces`: one isolated workspace per
  registered Telegram group.
- `users` and `workspace_members`: Telegram identity plus group-scoped role and
  membership status.
- `reminders`, `reminder_watchers`, and `reminder_runtime`: reminder definition,
  observers, and current scheduling slot.
- `reminder_occurrences` and `reminder_occurrence_slots`: actionable instances
  and their uniqueness guard.
- `notification_deliveries`: deterministic delivery reservations and results.
- `audit_events`: workspace-scoped history.

The legacy bootstrap schema is in `infra/ydb/schema.sql`. Ordered, forward-safe
migrations live in `infra/ydb/migrations`; `scripts/apply-ydb-migrations.sh`
records their versions and checksums in `schema_migrations`. Production deploys
apply outstanding migrations after tests and before updating functions. An
already recorded migration with a changed checksum aborts the deploy.

## Build and deployment

- CI runs on Node.js 22, matching the supported Yandex Cloud Functions runtime:
  install, typecheck, test, build.
- A push to `main` applies outstanding YDB migrations, deploys both functions,
  uploads the Mini App, and resets the Telegram webhook.
- The deploy job validates all required `production` secrets before changing
  cloud resources. Both functions receive the configured runtime service
  account, and the universal UI is deployed only when the matching runtime flag
  is explicitly enabled.
- Infrastructure resources use the `zvenfit-reminder-` prefix. Existing
  installations created with the former `payments-reminder-` prefix are not
  renamed in place by these scripts; provision or migrate them deliberately
  before the first deployment under the new name.

## Known risks and gaps

1. `ALLOWED_CHAT_ID` remains only for the disabled legacy dispatcher. Universal
   authorization derives the workspace from the group chat or the authenticated
   Mini App membership and scopes every repository operation by workspace.
2. Telegram cannot enumerate all group members. Automatic join and activity
   observation cover normal use, while the native picker imports at most ten
   selected users per request after `getChatMember` verification.
3. If the workspace owner leaves, their membership becomes inactive and their
   assignments pause, but ownership is retained for safe restoration on return.
   Explicit ownership transfer is not implemented yet.
4. A Telegram send whose result cannot be classified is stored as `unknown`.
   The dispatcher prefers a missed repeat over duplicate spam; operational
   reconciliation for unknown deliveries is still manual.
5. Repository and service behavior is unit-tested, but there are no YDB
   integration tests or automated Mini App component tests.
6. There is no configured linter or formatter.
7. The bootstrap service account receives broad folder roles including
   `editor`, and CI installs the Yandex Cloud CLI through an unpinned
   `curl | bash` script. Production hardening should split runtime/deploy
   identities, reduce roles, and pin the installation path.

## Verification baseline

Run `npm run check` before handing changes off. It covers typechecking, unit
tests, and every production build. Node.js 22 is the CI and production runtime
compatibility baseline.

The baseline is updated with each change through CI; do not rely on historical
test counts in this document.
