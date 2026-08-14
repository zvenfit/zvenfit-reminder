# Redesign implementation record and remaining roadmap

This document records the move from the payment-reminder prototype to
[product-spec.md](product-spec.md) and
[target-architecture.md](target-architecture.md). The core domain, group-scoped
runtime, clean schema, current-action screen, creation flow, group settings,
roles, and cutover code are complete. The fuller Plan/History experience,
calendar feeds, and the explicitly listed hardening work remain.

## Phase 0: target specification

- Keep the current implementation documented as a prototype.
- Approve product behavior, UX direction, target data model, and cutover plan.
- Establish the documentation set and link it from the README.

Exit criterion: the product and architecture documents contain no unresolved
behavioral decisions required for implementation.

## Phase 1: shared domain and scheduling

- Replace payment-specific shared types with workspace, reminder, occurrence,
  delivery, role, and audit types.
- Define versioned discriminated schedule schemas.
- Implement next-occurrence calculation for once, daily, weekly, monthly,
  yearly, and every-N schedules.
- Implement reminder-start offsets, quiet-hour adjustment, snooze, escalation,
  and upcoming-date previews.
- Keep monetary values in minor units and validate ISO currency codes.

Tests:

- timezone and daylight-saving transitions;
- leap years, 29 February, and monthly overflow 29–31;
- timed versus all-day deadlines;
- recurring creation after today's scheduled time;
- every-N boundaries;
- schedule edits and paused periods;
- only one incomplete occurrence;
- notification timing through quiet hours;
- snooze returning to the base interval.

Exit criterion: shared scheduling and validation have exhaustive deterministic
tests independent of YDB and Telegram.

## Phase 2: greenfield YDB schema — completed

- Add ordered migration scripts plus `schema_migrations`.
- Create the target tables and indexes as one clean initial migration.
- Implement workspace-scoped repositories and transaction helpers.
- Implement occurrence materialization and notification reservation.
- Use the per-reminder runtime row to enforce one incomplete occurrence without
  relying on a scan for absence.
- Add repository integration tests against local YDB.

No row-level conversion is required because the pre-release data is disposable.
The normal deploy remains non-destructive; an explicit guarded reset command is
documented in [database-reset.md](database-reset.md).

Exit criterion: the new repositories pass concurrency and authorization tests
and no service method accepts a bare unscoped entity ID.

## Phase 3: API and authorization

- Add workspace membership and role management.
- Replace rule CRUD with reminder, dashboard, plan, history, and occurrence
  action endpoints.
- Enforce Telegram init-data verification followed by membership and role
  authorization.
- Normalize invalid JSON, validation, authorization, and conflict responses.
- Make completion, snooze, undo, reopen, pause, resume, and archive idempotent.

Tests:

- owner, organizer, member, non-member, and removed-member permissions;
- group versus private visibility;
- private reminder isolation from unrelated owners and organizers;
- callback tampering and cross-workspace IDs;
- personal reminder delivery preconditions;
- `current` versus `series` edit scope;
- stable 400, 401, 403, 404, and 409 responses.

Exit criterion: handler and service tests cover every role and state transition.

## Phase 4: dispatcher and Telegram UX

- Replace the current cron rule scan with due-occurrence materialization and
  reserved delivery processing.
- Advance the next notification before external send.
- Implement one-live-message cleanup, compaction fallback, snooze edits,
  completion edits, and ten-minute undo.
- Add watcher escalation and private delivery.
- Preserve minimal bot commands as operational fallbacks.

Tests:

- parallel cron invocations;
- duplicate primary and repeat attempts;
- crash after reservation but before send;
- ambiguous Telegram timeout;
- previous-message deletion failure;
- unauthorized and repeated callbacks;
- completion racing with a scheduled delivery.

Exit criterion: concurrency tests demonstrate no duplicate scheduled attempt and
the chain continues after one failed or unknown delivery.

## Phase 5: Quiet Pulse Mini App — partially complete

- Introduce app-level routing and query/cache state instead of a single component.
- Build Tasks, Plan, History, reminder detail, creation/editing, and Settings.
- Implement the continuous timeline, week strip, live next-ping countdown, and
  plain-language schedule preview.
- Add role management, quiet-hour settings, and private-chat readiness states.
- Self-host Onest and IBM Plex Mono.
- Support Telegram light/dark themes, safe areas, back button, keyboard focus,
  and reduced motion.

Tests:

- component state and keyboard behavior;
- visual regression at narrow and wide Telegram viewports;
- light, dark, loading, empty, error, and long-content states;
- creation flow for every schedule type;
- permissions hiding or disabling unavailable actions;
- undo and edit-scope interactions.

Exit criterion: the complete product can be operated from the Mini App without
using fallback bot commands.

Current status: the attention screen, creation, current-and-future series editing,
pause/resume/archive, assignment, completion, snooze, undo, reassignment, role
management, group switching, and rhythm settings are implemented. Dedicated
Plan, History, a full reminder detail screen, and calendar settings remain.

## Phase 6: calendar feeds

- Create, list, revoke, and rotate per-user feed tokens.
- Generate stable read-only ICS feeds for Google, Apple, and Yandex Calendar.
- Export deadlines only and mark timed events as non-blocking.
- Add connection instructions and provider-specific caveats.
- Ensure tokens and private reminder content never enter logs.

Exit criterion: all three target providers can subscribe to a test feed and
observe updated events after their normal refresh delay.

Native Google OAuth synchronization remains a separate later project and is not
required for this release.

## Phase 7: cutover — implemented in code, production reset pending

1. Reset the disposable production database with the guarded reset command.
2. Deploy the functions and Mini App from `main`.
3. Run production smoke tests for group send, private send, snooze, completion,
   escalation, recurrence, settings, and ownership transfer.
4. Recreate any desired reminders manually.

Legacy repositories, APIs, feature flags, and schema files have been removed.
No destructive DDL runs automatically during a normal application deploy.

## Verification gates

Every implementation phase ends with:

```bash
npm run check
```

Additional release gates:

- local YDB integration suite;
- cron concurrency suite;
- Mini App visual regression suite;
- production-like Telegram callback fixtures without calling the live API;
- manual smoke test in a non-production Telegram group;
- review of schema changes and rollback procedure.

## Documentation updates during implementation

- Update [architecture.md](architecture.md) when the target replaces the
  prototype.
- Keep API payload examples beside the implemented handlers.
- Add an operator runbook for delivery failures and unknown Telegram results.
- Update [local-dev.md](local-dev.md) for new schema bootstrap and role setup.
- Replace [smoke-test.md](smoke-test.md) with target product scenarios before
  cutover.
- Record each schema change as an ordered migration and document whether it is
  forward-safe.

## Deferred ideas

- Native Google Calendar OAuth and two-way edits.
- Additional recurrence patterns discovered through real usage.
- Workspace retention configuration.
- Attachments, checklists, and completion evidence.
- Multiple simultaneous responsible people.
- Multi-channel delivery beyond Telegram.
