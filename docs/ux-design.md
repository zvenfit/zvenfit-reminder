# UX and visual design: Quiet Pulse

Status: approved and implemented core design for the Mini App and Telegram messages. Product
behavior is specified in [product-spec.md](product-spec.md).

## Design thesis

The interface should feel calm while the behavior remains persistent. It is a
mobile agenda for commitments, not an administrative dashboard.

The main screen has one job: answer "what needs attention now?" within a few
seconds.

## Approved design contract

Approved: 17 August 2026. This section is the source of truth for Mini App UI
changes. It records decisions that should not drift during routine feature
work. Product behavior remains governed by [product-spec.md](product-spec.md).

### Invariants

1. **Quiet agenda, not a control panel.** Content and urgency outrank workspace
   administration and decoration.
2. **The attention rail is the signature.** Only the nearest relevant item may
   use the strongest surface. Later items remain visually quieter and preserve
   chronological continuity.
3. **One typographic voice.** Onest is used for interface copy; IBM Plex Mono is
   reserved for times, dates, amounts, and live numeric data. Do not introduce
   another interface family or use monospace as decoration.
4. **One component grammar.** Controls use a 12px radius, panels use 16px, and
   circles are reserved for avatars, rail nodes, and status markers. Pills are
   reserved for compact filters and statuses.
5. **Semantic color is stable.** Pulse means primary action or next signal;
   Coral means overdue or destructive; Done means completed; Amber means
   approaching deadline or paused. Never use these colors as arbitrary accents.
6. **Actions read as actions.** Labels use active, explicit language such as
   `Отметить выполнение`, `Напомнить через час`, and `Архивировать`. A pending
   action must not resemble a completed-state badge.
7. **Mobile content is never covered.** Floating and sticky controls must not
   obscure tasks or fields at 320px width, short Telegram viewports, or with the
   software keyboard open.
8. **Series scope is explicit at the action.** A recurring occurrence names its
   task rhythm anywhere it can be completed, and completion copy says that only
   the current deadline is closed. The confirmation names the next deadline.
   `Task rhythm` and `signal rhythm` are separate concepts in both labels and
   preview copy; `daily` must never leave the user guessing which one repeats.

### Component and type scale

| Role | Contract |
| --- | --- |
| Caption and numeric data | 12px; IBM Plex Mono only when the value is data |
| Field label | 12px Onest, semibold |
| Body and control | 14px Onest |
| Compact and attention item title | 16px Onest, semibold or bold |
| Section title | 18px Onest, bold |
| Page title | 26px Onest, bold; 28px only on viewports from 680px |
| Standard control | minimum 44px high |
| Primary action | minimum 48px high |
| Icon | one consistent outline SVG style; do not use OS-dependent Unicode glyphs |

Use one border and spacing hierarchy before adding shadows. Shadows are allowed
only for genuinely elevated or signature surfaces. Prefer whitespace and rules
to nested cards.

The mobile type scale is deliberately capped at 26px. A title must never force
essential context or the first useful action below the initial viewport merely
to create visual drama. Supporting copy must not drop below 12px.

### Change protocol

- Preserve these invariants during ordinary feature work.
- If a product requirement conflicts with the contract, update this document
  first and record the reason; do not introduce a silent exception in CSS.
- Reuse or extend existing tokens and components before adding a new visual
  primitive.
- Review every material UI change at 320px and 412px in light and dark themes.
- Verify visible focus, reduced motion, 44×44px targets, semantic state text,
  safe-area behavior, and absence of horizontal overflow.
- Run `npm run check` and the Mini App Playwright suite before handoff.

Decision record: the August 2026 unification retained Quiet Pulse, the attention
rail, and the semantic palette; it removed competing system fonts, decorative
monospace, mixed Unicode icons, inconsistent radii, undersized controls, and
content-covering mobile actions.

### Snooze action sheet

`Напомнить позже` opens the same modal action sheet from Tasks and occurrence
detail. It replaces destination-specific instant actions and is the only Mini
App primitive for choosing a snooze time.

- The first choices are `Через час`, `Вечером`, and `Завтра утром`; each shows
  its concrete local result before selection. `Вечером` is omitted when its
  valid window has already passed.
- `Завтра утром` uses the workspace all-day reminder time. All labels use the
  occurrence timezone, never the browser timezone.
- `Выбрать дату и время` reveals explicit local date and 24-hour time fields.
- A choice submits once. All mutation controls for the occurrence stay disabled
  while the request is pending; errors remain inside the sheet and preserve the
  draft for a deliberate retry.
- Success copy uses the effective time returned by the server. If quiet hours
  moved the chosen time, the confirmation says so instead of repeating the
  user's original choice.
- Named calendar choices move to the first valid local time across a timezone
  clock change. An exact custom time that is missing or ambiguous is not guessed;
  the sheet keeps the draft and asks for another time.

On narrow and short viewports the dialog is a bottom sheet with internal
scrolling and safe-area padding. From 600px it uses the existing centered dialog
geometry. It traps focus, closes on Escape or Telegram Back, restores focus to
its trigger, and respects reduced motion. This is an elevated surface allowed by
the existing dialog grammar; it does not introduce new color, radius, shadow,
or icon tokens.

### Maturity pass: 17 August 2026

The second August iteration closed the remaining structural gaps without
changing the Quiet Pulse signature:

- the main screen now contains only current actionable occurrences and a quiet
  link into the plan;
- `Tasks`, `Plan`, and `History` are persistent primary destinations;
- an occurrence and its series share one detail grammar for state, deadline,
  responsible person, next signal, related link, amount, schedule, and audit
  facts;
- recurring schedules show three concrete future local dates in both the form
  preview and Plan;
- editing an active recurring occurrence explicitly chooses `Only this
  occurrence` or `This and future`; the former uses an occurrence-scoped API and
  audit event and does not mutate the series definition;
- archive uses an accessible in-product confirmation dialog; native browser
  confirmation is not part of the UI grammar;
- launch recovery offers both refresh and a direct deep link to the bot;
- the attention rail names relative overdue time and the next notification.

This iteration was verified with group owner, ordinary member, unrelated
member, private reminder, recurring series, reassignment, completion/undo,
history, launch recovery, and narrow-viewport scenarios. The permanent browser
suite covers mobile and desktop Chromium; the design review also covers 320px
and 412px light/dark captures.

## Information architecture

Primary navigation:

- **Tasks**: current pending and overdue occurrences that can be seen by the
  actor. It is the only primary view with completion and quick snooze actions.
- **Plan**: active and paused reminder definitions with their next three
  concrete dates. Series management lives in the detail view, keeping the list
  scannable.
- **History**: completed and cancelled occurrences. Each row opens immutable
  occurrence facts, including actor and timestamp; later reopen remains an
  explicit product transition rather than an implicit row action.
- **Settings**: workspace, roles, quiet hours, calendar subscription, and
  personal preferences; accessed from the profile control rather than occupying
  a primary bottom tab.

Group reminders are the default scope. `Моя лента / Вся группа` filters are
available on Tasks, Plan, and History. `Моя лента` means assigned to the
actor, completable by anyone, or created by the actor; it does not imply private
visibility.

Typography stays deliberately compact: working-section headings such as
`Требует внимания` are 20px, primary page titles are 26px on mobile and 28px on
wide screens, and no ordinary product copy is smaller than 12px. No ordinary
product screen uses landing-page hero sizing.
The workspace selector has its own compact control geometry and chevron; generic
form-field heights and native select arrows must not leak into navigation.

## Main screen

The layout is a continuous agenda rather than a stack of visually identical
cards.

```text
Today, 13 August                                      +

2 tasks need attention
[ Mine ] [ All ]

OVERDUE

 ●── 08:00  Submit meter readings
 │          Sergey · overdue by 2 days
 │          Next ping in 03:42
 │
 ●── 18:00  Pay for internet
 │          Anna · ₽12,500
 │
 ○── tomorrow Order cat food
            Anyone can complete

[ Tasks ]              [ Plan ]              [ History ]
```

The left rail encodes real sequence and state:

- filled node: notification window has started;
- empty node: scheduled for later;
- coral node: overdue;
- green node: completed;
- a pulse label: time until the next notification.

Only the nearest relevant item receives a stronger surface treatment. The rest
are rows separated by spacing and rules, avoiding generic "card soup."

## Plan view

The default Plan view is a vertical series ledger. Every row names the human
recurrence rule, responsible person, state, and up to three concrete local
dates. This is more legible than a compressed week strip when series have
monthly or yearly cadence, while still answering “what are the next actual
dates?” without opening the form.

Selecting the row opens shared details. Edit, pause/resume, reassignment, and
archive remain secondary controls below the dates. A calendar grid is not a
default mobile primitive and may be added only for a demonstrated planning
need.

## Creation flow

Creation follows four human questions:

1. What needs to be done?
2. Who is responsible?
3. When is it due?
4. How should reminders work?

The default path exposes only the fields needed to save a valid reminder.
Description, link, amount, watchers, escalation overrides, and night delivery
are under `Additional settings`.

The form ends with a continuously updated plain-language preview:

> Sergey must submit meter readings by 25 August at 18:00. Reminders start one
> day before and repeat every six hours until completion.

The schedule and notification policy must remain visibly separate. `Срок`
answers when the commitment is due and how that due date recurs. `Сигналы`
answers when the bot first speaks and how often it returns while the occurrence
is still open. A deadline control must never be titled `Когда напоминать`.

The form calls these concepts `Ритм задачи` and `Ритм сигналов`. The first says
when a new deadline appears; the second says how the bot repeats while that one
deadline remains open. For a recurring definition, the preview explicitly says
that each deadline is completed separately.

The preview names all three facts independently: the deadline, the first
signal, and the repeat policy. For an all-day occurrence, the deadline is the
end of the local calendar day while the zero-lead signal uses the workspace's
`defaultAllDayReminderTime`; copy therefore says, for example, `В день срока,
в 09:00`, never `В момент срока`. Quiet-hour copy uses the selected workspace's
actual interval and explains that a blocked signal moves to the end of that
interval. The exact next delivery shown after saving always comes from
`nextNotificationAt` returned by the server.

Before saving, the first-signal preview mirrors server scheduling: a requested
lead time that has already passed becomes `Сразу после сохранения`, and a
candidate inside quiet hours names the effective wake time. Preview clocks are
live rather than frozen at page load.

The first-signal control accepts a numeric amount and an explicit `часов` or
`дней` unit instead of limiting the user to presets. Zero remains the
at-deadline choice and the maximum is 365 days. Payment details pair the amount
with an explicit `₽ · RUB` or `$ · USD` currency choice; all later amount labels
format the stored ISO currency code.

### Form validation and calendar controls

Validation stays next to the field that needs correction. Errors use concise
actionable copy, `aria-invalid` and an associated description; correcting the
value clears its stale error without clearing the rest of the draft. A blocked
save or native constraint check scrolls to and focuses the first invalid
control in visual order. The 24-hour time control follows the same contract and
does not silently coerce a time outside `00:00`–`23:59`.

Calendar-derived defaults and applicable minimum dates use the selected
workspace timezone (or the reminder timezone while editing), never the device
timezone. A new one-off reminder defaults to tomorrow and cannot be dated
before today in that timezone. Recurring defaults for the start date, weekday,
month, and day are derived from today in the same timezone. This contract also
applies around midnight, where the browser and workspace may be on different
calendar dates.

Date fields always show and accept `ДД.ММ.ГГГГ`, for example `30.08.2026`,
regardless of the browser or Telegram WebView locale. The value remains an ISO
calendar date at the API boundary. A 48×48 calendar affordance inside the field
opens the platform's native picker and preserves applicable minimum and maximum
dates; browser-specific numeric ordering is never the visible representation.

Recurring interval inputs show the unit beside the number, accept integers
from 1, and expose the same frequency-specific upper bounds as the domain
schema:

| Frequency | Unit | Allowed interval |
| --- | --- | --- |
| Daily | days | 1–365 |
| Weekly | weeks | 1–52 |
| Monthly | months | 1–120 |
| Yearly | years | 1–20 |

Invalid values are rejected rather than rounded or silently clamped. Monthly
day 29–31 keeps the documented last-day overflow behavior. A yearly date must
exist in its selected month: for example, 31 February is rejected inline;
29 February remains a valid annual rule.

Frequency choices and other single-choice radio/tab groups use one roving tab
stop with arrow-key navigation. The weekday selector preserves native
multi-select button semantics. Every weekday target is at least 44×44px with
12px text; at 320px the seven targets wrap without horizontal overflow.

Quiet-hours copy describes the active outcome instead of merely naming the
setting. With night delivery off, it says that signals inside the workspace
interval move to the interval end; with night delivery on, it says they will
also arrive during that interval. If the workspace has quiet hours disabled
(equal start and end), the form says so, disables the night-delivery checkbox,
and keeps it unchecked.

### Recommended control order

```text
What needs to be done?
[ Submit meter readings                    ]

Visibility
[ Group ] [ Private ]

Responsible
[ Sergey                                  >]

Schedule
[ Monthly, on the 25th at 18:00           >]

Reminders
[ One day before · every 6 hours           >]

[ Additional settings                     >]

Plain-language preview
[ Save reminder ]
```

Upcoming-date preview is mandatory for recurring schedules, especially monthly
days 29–31.

## Detail and action views

The detail screen prioritizes:

1. current state and deadline;
2. responsible person;
3. next notification;
4. `Complete` and `Snooze`;
5. description, link, and amount;
6. schedule and audit history;
7. edit, pause, and archive actions.

Destructive or administrative actions stay out of the primary thumb zone.

Every active recurring occurrence shows the human recurrence rule beside its
completion action. Supporting copy says that the action closes this deadline,
not the whole series. After completion, the undo confirmation says `Этот срок
выполнен` (or the payment equivalent) and names the next concrete local
deadline. A one-off occurrence keeps the shorter completion copy. Completing a
deadline must never silently archive its series; pause and archive remain
separate series-management actions.

For an active occurrence, the exact local date and time of `Следующий сигнал`
is the primary value; `Через …` is supporting copy. A signal whose scheduled
instant has passed says `Ожидает отправки`, not `Через …`. The same exact value
is used on the Tasks rail and in detail, formatted in the occurrence timezone.
Supporting copy states whether quiet hours are respected or explicitly
ignored. When a snooze response reports an adjustment, the confirmation names
both the requested and effective local times.

History rows keep actor and assignee as separate facts: what happened and who
did it, the action time, the original deadline, and the responsible person.
Cancellation reason belongs to the occurrence detail. Audit copy wraps at
320px instead of being truncated, and history is ordered by action time rather
than deadline time, with a stable ID tie-breaker.

For an active recurring occurrence, editing prompts for `Only this occurrence`
or `This and future occurrences`. Plan-level edit starts directly in series
scope because no single occurrence was selected. Completed history is visually
read-only unless a later product transition deliberately exposes `Reopen`.
Occurrence and series scopes keep isolated drafts: switching scope must restore
the corresponding source values and must never copy one occurrence's content,
assignees, watchers, or notification policy into the series definition.

## Telegram copy and controls

Every message has exactly one primary state: upcoming, deadline reached,
overdue, snoozed, completed, cancelled, or paused. Completion, cancellation,
pause, and snooze replace the previous state copy; they are never appended
below an old `Просрочено` header. Escalation is delivery context, not another
state, and watcher mentions appear only for a group escalation delivery.

Initial group message:

```text
🔔 Submit meter readings

Complete by today, 18:00
Task rhythm: every month · on the 25th · 18:00
Responsible: @sergey

Next ping in 6 hours

[ Complete ] [ Snooze ]
```

An initial signal scheduled exactly at the deadline and delivered within the
normal five-minute timer polling window uses `Deadline reached` (`Срок
наступил`) rather than `Overdue`. A repeat signal, a substantially delayed
initial signal, or an initial signal deferred past the deadline by quiet hours
uses the overdue state.

Snoozed state:

```text
💤 Submit meter readings

Next signal: tomorrow, 08:00
Deadline unchanged: today, 18:00
[ Complete ] [ Snooze again ]
```

The Telegram keyboard exposes preset choices for one hour, the evening, and
tomorrow morning without mutating the shared keyboard into a temporary menu.
Legacy `+1 час` callbacks remain valid. Exact date and time selection lives in
the Mini App action sheet.

Completed state:

```text
✅ Submit meter readings

This deadline was completed by Sergey · today, 14:32
Next deadline: 25 September, 18:00
[ Undo completion ]
```

For recurring messages, both the text and the completion control use current-
deadline scope. One-off messages omit series language and keep the concise
action. The exact next deadline is included only when the series has another
occurrence.

Administrative completion names both people:

> Completed by Anna for Sergey · today, 14:32

Errors are direct and actionable. An unauthorized callback answers:

> Sergey is responsible for this task.

## Visual system

### Light palette

| Token | Value | Use |
| --- | --- | --- |
| Fog | `#F4F6FA` | App background |
| Ink | `#182033` | Primary text |
| Pulse | `#5B67F1` | Primary actions and next ping |
| Amber | `#E6A23C` | Approaching deadline |
| Coral | `#E05B67` | Overdue state only |
| Done | `#2F9E77` | Completed state |

### Dark palette

| Token | Value | Use |
| --- | --- | --- |
| Night | `#0F1420` | App background |
| Slate | `#182033` | Elevated surfaces |
| Snow | `#F2F5FA` | Primary text |
| Pulse | `#7D85FF` | Primary actions and next ping |
| Coral | `#FF7A84` | Overdue state only |
| Done | `#55C99A` | Completed state |

Telegram theme values inform status-bar and safe-area integration, but the app
keeps this semantic product palette so states remain consistent.

### Typography

- **Onest**: all interface text, headings, labels, and buttons.
- **IBM Plex Mono**: times, dates when used as data, and live countdowns only.

Fonts should be self-hosted with the Mini App bundle. Numeric countdowns use
tabular glyphs so their width remains stable.

### Shape and spacing

- Base spacing unit: 4px.
- Main horizontal gutter: 16px on narrow screens, 24px on wider Mini App views.
- Touch target minimum: 44×44px.
- Surfaces use moderate 12–16px radii; timeline rows generally remain unboxed.
- Borders encode grouping or state and are never purely decorative.

## Motion

The signature motion happens once on page entry: a soft signal travels down the
timeline rail and stops at the nearest item requiring attention.

No element pulses continuously. State changes use short opacity and position
transitions. `prefers-reduced-motion: reduce` removes the traveling signal and
all non-essential movement.

## Empty, loading, and error states

- Empty Tasks: `Nothing needs attention. Create a reminder for the next thing
  you do not want to chase manually.`
- Empty History: `Completed tasks will appear here.`
- Initial and workspace-switch loading: preserve the final dashboard geometry
  with a structural skeleton. Do not render temporary zero counts or empty
  states before the critical dashboard data resolves. Skeleton motion may run
  once on entry, then remains still.
- Missing private chat: explain that the responsible person must open the bot,
  with an `Open bot` action.
- Load failure: keep cached content if present and offer `Try again`.
- Actionable error banners keep the message and retry control as separate,
  spaced elements; an action is never appended inline to the error sentence.
- Read failures use an explicit contextual verb such as `Load data`, `Load
  history`, or `Refresh list`; a successful retry removes the banner without
  moving the user to another screen.
- Partial reads keep fulfilled or previously cached resources usable. A missing
  resource shows `not loaded` and an em dash instead of a false zero, empty
  plan, or `nothing needs attention` state.
- Write failures retain the draft and the original action but are not replayed
  automatically. A lost response may hide a successful write, so a generic
  retry must never risk duplicate reminders, messages, or state transitions.
- Save failure: retain every entered field and identify the invalid or failed
  action.

## Accessibility and Telegram constraints

- Use semantic buttons, labels, fieldsets, headings, and live regions.
- Never encode status by color alone; pair it with text and node shape.
- Provide visible keyboard focus and sufficient color contrast.
- Respect Telegram safe-area insets, viewport changes, back button behavior,
  and light/dark color scheme.
- Disable action buttons while their callback is pending and make every action
  idempotent server-side.

## Self-critique applied

The initial temptation was a collection of rounded reminder cards with colorful
badges. That approach was rejected because it would look like a generic task
dashboard and obscure chronology. The continuous timeline and countdown are
specific to this product's persistent notification model; color and motion stay
subordinate to that structural idea.
