# Redesign implementation plan

This plan moves the current payment-reminder prototype toward
[product-spec.md](product-spec.md) and
[target-architecture.md](target-architecture.md). It is intentionally staged so
each checkpoint remains testable and deployable.

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

## Phase 2: greenfield YDB schema

- Add ordered migration scripts plus `schema_migrations`.
- Create the target tables and indexes without dropping the legacy tables.
- Implement workspace-scoped repositories and transaction helpers.
- Implement occurrence materialization and notification reservation.
- Use the per-reminder runtime row to enforce one incomplete occurrence without
  relying on a scan for absence.
- Add repository integration tests against local YDB.

The old tables remain untouched during development. Because current production
data is disposable, no row-level conversion is required. Keeping the tables
temporarily still gives a reversible cutover and avoids destructive deployment
steps.

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

## Phase 5: Quiet Pulse Mini App

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

## Phase 7: cutover

1. Deploy new tables, functions, and Mini App while the legacy data path remains
   available but disabled behind configuration.
2. Run local and non-production smoke tests.
3. Pause the legacy timer.
4. Switch the functions to the new repositories and schema.
5. Recreate desired reminders manually in the new product.
6. Run production smoke tests for group send, private send, snooze, completion,
   escalation, and recurrence.
7. Keep legacy tables for a short rollback window.
8. Remove legacy repositories, APIs, UI, and tables in a later explicit cleanup.

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
