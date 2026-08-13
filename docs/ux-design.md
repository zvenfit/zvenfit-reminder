# UX and visual design: Quiet Pulse

Status: approved and implemented core design for the Mini App and Telegram messages. Product
behavior is specified in [product-spec.md](product-spec.md).

## Design thesis

The interface should feel calm while the behavior remains persistent. It is a
mobile agenda for commitments, not an administrative dashboard.

The main screen has one job: answer "what needs attention now?" within a few
seconds.

## Information architecture

Primary navigation:

- **Tasks**: overdue, today, upcoming, and paused work.
- **Plan**: compact week visualization and later dates.
- **History**: completed, cancelled, snoozed, reassigned, and reopened work.
- **Settings**: workspace, roles, quiet hours, calendar subscription, and
  personal preferences; accessed from the profile control rather than occupying
  a primary bottom tab.

Group reminders are the default scope. `Mine / All` filters are available on
Tasks and Plan.

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

The default planning horizon is one week, optimized for a narrow Telegram Mini
App viewport.

```text
13 Wed     14 Thu      15 Fri      16 Sat
            ● 10:00     ● 09:00
            Lab tests   Internet
            Sergey      Anna
```

Selecting a date opens its agenda below the week strip. A month grid may be
added later, but it is not the default mobile view.

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

For recurring reminders, editing prompts for `Only this occurrence` or `This
and future occurrences`. Completed history is visually read-only unless an
organizer deliberately selects `Reopen`.

## Telegram copy and controls

Initial group message:

```text
🔔 Submit meter readings

Complete by today, 18:00
Responsible: @sergey

Next ping in 6 hours

[ Complete ] [ Snooze ]
```

Snoozed state:

```text
💤 Submit meter readings

Sergey snoozed this until tomorrow, 08:00
[ Complete ] [ Change snooze ]
```

Completed state:

```text
✅ Submit meter readings

Completed by Sergey · today, 14:32
[ Undo completion ]
```

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
- Missing private chat: explain that the responsible person must open the bot,
  with an `Open bot` action.
- Load failure: keep cached content if present and offer `Try again`.
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
