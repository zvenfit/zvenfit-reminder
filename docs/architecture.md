# Current architecture and engineering notes

> This document describes the checked-in payment-reminder prototype. The
> approved redesign is documented in
> [product-spec.md](product-spec.md),
> [ux-design.md](ux-design.md),
> [target-architecture.md](target-architecture.md), and
> [implementation-plan.md](implementation-plan.md). Until the redesign is
> implemented, do not treat the target documents as a description of current
> runtime behavior.

## What the system does

The current `zvenfit-reminder` manages monthly and one-off payment reminders for one
Telegram group. A Telegram Mini App provides rule CRUD, a timer-backed Cloud
Function sends due reminders, and group members complete or skip reminder
instances from inline buttons or bot commands.

## Runtime topology

```text
Telegram updates ──> API Gateway /webhook ──> bot-webhook function
                                              ├─ bot commands/callbacks
Mini App ──────────> API Gateway /api/* ──────┤
                                              └─ rules/members API

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

The bot middleware accepts updates from `ALLOWED_CHAT_ID`. Universal-reminder
callbacks, `/start`, and native user-picker results are also accepted in private
chats and then authorized through workspace membership and role. Every observed
group sender is upserted into `group_members` and the universal member model.
Telegram does not provide an API for listing every group member. Owners and
organizers can therefore select up to ten users at a time in the private bot
chat; the backend verifies every selected ID with `getChatMember` against
`ALLOWED_CHAT_ID` before saving it. Manual sync remains a fallback for admins,
cached users, and the requesting user.

### Mini App API

Requests carry `X-Telegram-Init-Data`. The backend verifies Telegram's HMAC and
a 24-hour maximum age, then exposes rule and member operations for the single
configured group. A development-only bypass requires both
`SKIP_INIT_DATA_VALIDATION=1` and a non-production `NODE_ENV`.

### Reminder dispatch

Every five minutes the cron function loads active rules. Monthly due times are
calculated in the rule's IANA timezone; a requested day beyond a month's end is
clamped to the final day. Both recurring and one-off reminders remain eligible
for 24 hours after their due time.

Before sending, cron looks for an instance with the same `rule_id` and
`due_at`. A persisted message ID suppresses another send. Failed persistence
after a successful Telegram send can still duplicate a reminder because the
Telegram call happens before the instance write and the database does not have
a unique `(rule_id, due_at)` key.

Completing or skipping an instance archives a one-off rule; recurring rules stay
active for the next month.

## Data model

- `rules`: schedule, optional amount in kopecks, target chat and mentions,
  lifecycle status.
- `reminder_instances`: one delivery occurrence and its completion state.
- `group_members`: Telegram identity cache keyed by chat and user.

The legacy bootstrap schema is in `infra/ydb/schema.sql`. Ordered, forward-safe
migrations live in `infra/ydb/migrations`; `scripts/apply-ydb-migrations.sh`
records their versions and checksums in `schema_migrations`. Normal application
deploys do not apply migrations automatically.

## Build and deployment

- CI runs on Node.js 22, matching the supported Yandex Cloud Functions runtime:
  install, typecheck, test, build.
- A push to `main` deploys both functions, uploads the Mini App, and resets the
  Telegram webhook.
- The deploy job validates all required `production` secrets before changing
  cloud resources. Both functions receive the configured runtime service
  account, and the universal UI is deployed only when the matching runtime flag
  is explicitly enabled.
- Infrastructure resources use the `zvenfit-reminder-` prefix. Existing
  installations created with the former `payments-reminder-` prefix are not
  renamed in place by these scripts; provision or migrate them deliberately
  before the first deployment under the new name.

## Known risks and gaps

1. A valid Telegram Mini App signature proves the user opened this bot, but the
   API does not currently require that user to be an admin or a member of
   `ALLOWED_CHAT_ID`. Any such user can manage the configured group's rules.
2. Rule-by-ID updates and archives are not additionally scoped by chat ID. The
   deployment is designed for one chat, but this becomes a tenant-isolation bug
   if a database is shared by multiple installations.
3. Cron's read/send/write sequence is not atomic and has no unique database
   constraint, so concurrent invocations or a post-send failure can duplicate a
   message.
4. Invalid JSON and Zod validation failures are not converted into stable 400
   responses by the production handler.
5. API validation does not enforce cross-field schedule invariants. A direct
   client can create a one-off rule without `dueAt`, submit an invalid
   `timeLocal`, or provide an invalid timezone; malformed active rules can then
   fail or disrupt a cron invocation.
6. Automated coverage is limited to shared scheduling, Telegram formatting,
   init-data verification, and YDB value decoding. There are no handler,
   repository integration, cron concurrency, or Mini App component tests.
7. There is no configured linter or formatter.
8. The bootstrap service account receives broad folder roles including
   `editor`, and CI installs the Yandex Cloud CLI through an unpinned
   `curl | bash` script. Production hardening should split runtime/deploy
   identities, reduce roles, and pin the installation path.

## Verification baseline

Run `npm run check` before handing changes off. It covers typechecking, unit
tests, and every production build. Node.js 22 is the CI and production runtime
compatibility baseline.

The Codex preparation pass on 2026-08-12 completed an offline `npm ci` and
`npm run check` on Node.js 22.22.3 with npm 12.0.1: all 28 unit tests and all
production builds passed, and npm reported zero known vulnerabilities.
