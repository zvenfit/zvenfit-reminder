# Codex project instructions

## Scope and identity

- The project name is `zvenfit-reminder`; the canonical repository is
  `https://github.com/zvenfit/zvenfit-reminder`.
- This is a private, local project. Never use Stefania, Stefania skills, its
  knowledge base, Yandex internal services, or files under `~/.stefania` for
  work in this repository.
- Work against the checked-out repository and local development tools by
  default. Do not deploy, change cloud resources, call the Telegram API, push,
  or mutate GitHub state unless the user explicitly asks.

## Secrets and generated files

- Never inspect, print, commit, or overwrite `.env`, `sa-key.json`, bot tokens,
  service-account JSON, webhook secrets, or Telegram init data.
- Use `.env.example` and `mini-app/.env.example` to understand configuration.
- Do not commit `dist/`, coverage, archives, editor settings, or other ignored
  generated artifacts.

## Repository map

- `functions/bot-webhook` — Telegram webhook, local polling bot, and Mini App API.
- `functions/reminder-cron` — scheduled reminder dispatcher.
- `packages/shared` — domain types, scheduling, Telegram formatting, and YDB repositories.
- `mini-app` — React/Vite Telegram Mini App.
- `infra` — YDB schema and Yandex Cloud bootstrap configuration.
- `docs/architecture.md` — runtime flows, invariants, and known risks.

## Development workflow

- Use Node.js 22, matching CI and the Yandex Cloud Functions runtime.
- Install reproducibly with `npm ci`.
- Run `npm run check` before handing off code changes. It runs typechecking,
  unit tests, and production builds for all workspaces.
- For a focused shared-package test, run
  `npm test --workspace=@zvenfit-reminder/shared -- <test-file>`.
- Local service commands and required environment variables are documented in
  `docs/local-dev.md`.

## Git workflow

- Never use the `codex/` prefix for branches in this repository.
- Name branches by change type, such as `feature/<topic>` or
  `bugfix/<topic>`.
- Use lowercase kebab-case for the topic and choose the prefix that matches the
  primary purpose of the change: `feature`, `bugfix`, `hotfix`, `refactor`,
  `chore`, `docs`, or `test`.
- Examples: `feature/reminder-history`, `bugfix/duplicate-cron-send`, and
  `docs/local-development`.

## Domain and compatibility rules

- Monetary amounts are integer kopecks in the backend and YDB; the Mini App
  converts rubles at the API boundary.
- Recurring rules use `dayOfMonth`, local `HH:mm`, and an IANA timezone.
  Days beyond the end of a month resolve to that month's last day.
- One-off `dueAt` values cross the API as ISO timestamps and are stored as YDB
  `Timestamp` values.
- `workspaceId` is the tenant boundary. Resolve it from a registered Telegram
  group or authenticated active membership and scope every read and write to it.
- Validate every API payload and Telegram callback before persistence.
- Keep the cloud resource prefix `zvenfit-reminder-` consistent across CI,
  infrastructure scripts, and documentation.

## Change discipline

- Add or update tests for scheduling, parsing, formatting, authorization, or
  persistence behavior when changing those areas.
- Preserve the idempotency intent in the cron path: one reminder instance per
  rule and due timestamp. See the concurrency caveat in `docs/architecture.md`.
- Treat `.github/workflows/ci.yml` pushes to `main` as production deploys.
- Do not silently change the YDB schema. Document migrations and make them safe
  for already provisioned databases.

## Mini App design discipline

- `docs/ux-design.md` is the source of truth for the approved Quiet Pulse design
  contract. Preserve its invariants when changing `mini-app/**`.
- Do not add a new font, icon language, radius, shadow, semantic color, or UI
  primitive without first updating the design contract with the reason.
- Check material UI changes at 320px and 412px in light and dark themes, including
  short Telegram viewports, safe areas, focus states, and content overlap.
- Keep `npm run check` and the Playwright Mini App suite passing when UI labels,
  semantics, or interactions change.
