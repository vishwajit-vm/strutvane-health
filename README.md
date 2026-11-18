# @strutvane/health

> **Status: `0.2.0-next.0` pre-release, built against `@strutvane/framework` 0.2.0-next.1. Not on npm yet.**

Application health checks for [Strutvane](https://github.com/vishwajit-vm/strutvane) apps, in the spirit of Spatie's Laravel Health:

- **Built-in checks:** database (reachable + latency), migrations (none pending), cache (write/read), disk space, storage (writable folders and disks), app key, debug mode in production, environment complete, plus heartbeats for the scheduler and queue workers.
- **Your own checks** with `defineCheck({ name, run })`.
- **Thresholds** (ok / warning / failed), **history** in a database table, and **rate-limited alerts** (Slack, signed webhooks, mail).
- **`node strut health:check`** with exit codes for CI and monitoring.
- **`GET /health.json`**, protected by a token or your policy. It is never public by default; `/up` stays the public liveness probe.

| | |
|---|---|
| Package | `@strutvane/health` |
| Needs | Node ≥ 24.3, npm ≥ 11.19, `@strutvane/framework` ^0.2.0-next.0 (peer) |
| License | MIT |

## Install

```bash
npm install @strutvane/health@next
node strut add health        # `node strut install:health` once the framework ships it
node strut migrate           # creates the health_check_results table
```

The installer:

1. writes `config/health.ts` (it never overwrites yours);
2. writes the migration `database/migrations/2026_11_18_000000_create_health_check_results_table.ts`;
3. adds `HEALTH_CHECK_TOKEN` to `.env` (a random 32-byte secret) and to `.env.example` (empty);
4. lists `HealthServiceProvider` in `bootstrap/providers.ts` and `health` in `config/index.ts`.

Every step is idempotent, so running it twice changes nothing and install order doesn't matter. If one of your files has a shape the installer doesn't recognise, it leaves the file alone and prints the line to add.

`node strut remove health` removes the provider, the config entry and the env key. It keeps `config/health.ts`, the migration and the table, because history is data.

## Run the checks

```bash
node strut health:check                         # table, alerts, history
node strut health:check --only database         # one check (repeatable)
node strut health:check --fail-on warning       # warnings fail too
node strut health:check --json                  # machine-readable
node strut health:list                          # what is registered
```

| Exit code | Meaning |
|---|---|
| 0 | Healthy. Warnings are allowed unless you pass `--fail-on warning`. |
| 1 | At least one check failed, or the app did not boot. |
| 2 | Usage error, for example `--only` names an unknown check. |

Schedule `health:check` every few minutes (cron, a systemd timer, or your platform's scheduler). It stores history and sends alerts. The JSON endpoint only reads.

## The JSON endpoint

```bash
curl -H "Authorization: Bearer $HEALTH_CHECK_TOKEN" https://app.example.com/health.json
```

```json
{ "status": "warning", "finishedAt": "2026-11-18T10:00:00.000Z",
  "checks": [{ "name": "database", "label": "Database", "status": "ok", "summary": "3 ms", "durationMs": 3 }, …] }
```

- It answers `200` for ok and warning and `503` for failed, so a plain uptime monitor works without parsing JSON.
- Access needs `Authorization: Bearer <token>` (or `X-Health-Token`). A token in the query string is ignored, because URLs end up in logs. The comparison runs in constant time.
- You can also allow requests through your policy instead of the token:

  ```ts
  app.make(HealthToken).authorizeUsing((ctx) => ctx.user?.role === 'admin')
  ```

- With neither a token nor a policy, the endpoint answers `404`.
- Wrong tokens are counted per client IP. After `max_failed_attempts` (default 10) in a minute, the endpoint answers `429`. The route also sits in the `api` middleware group and its rate limit.
- The response carries `Cache-Control: no-store`. It never includes meta, and includes messages only with `endpoint.expose_messages`.
- Reports are reused for `cache_seconds` (default 10), and concurrent requests share one run, so the endpoint can't be used to hammer your database.

## Configuration

`config/health.ts` is plain data, so it works with `node strut config:cache`. Every key has a safe default:

```ts
export default defineConfig((env) => ({
  timeout_ms: 5000,
  endpoint: { enabled: true, path: '/health.json', token: env.string('HEALTH_CHECK_TOKEN', ''),
              expose_messages: false, cache_seconds: 10, max_failed_attempts: 10 },
  history: { enabled: true, keep_days: 7 },
  checks: {
    database: { enabled: true, warn_ms: 100, fail_ms: 1000 },
    migrations: { enabled: true },
    cache: { enabled: true },                        // store: 'file' to pick one
    disk_space: { enabled: true, path: 'storage', warn_percent: 70, fail_percent: 90 },
    storage: { enabled: true, paths: ['storage/framework', 'storage/logs'] },   // disk: 'local'
    app_key: { enabled: true },
    debug_mode: { enabled: true },
    environment: { enabled: true, ignore: [], required: [] },
    heartbeats: [],                                  // ['scheduler', 'queue:default']
  },
  notifications: {
    on: 'failed', throttle_minutes: 60, recovery: true,
    slack_webhook_url: env.string('HEALTH_SLACK_WEBHOOK_URL', ''),
    webhook_url: env.string('HEALTH_WEBHOOK_URL', ''),
    webhook_secret: env.string('HEALTH_WEBHOOK_SECRET', ''),
    mail_to: env.string('HEALTH_MAIL_TO', ''),
  },
}))
```

The app refuses to boot on an invalid value and lists every problem with its key, for example a token shorter than 32 characters, `warn_ms` above `fail_ms`, or the endpoint path `/up`.

## The built-in checks

| Check | What it does | Warning / failure |
|---|---|---|
| `database` | `SELECT 1` on the app's connection | latency ≥ `warn_ms` / ≥ `fail_ms`, or unreachable |
| `migrations` | Compares `database/migrations` with the `migrations` table, by name | a migration ran but its file is gone / any pending migration |
| `cache` | Writes, reads back and deletes a random `health:probe:*` key | slow round trip / mismatch or error |
| `disk-space` | `statfs` on `storage` (the share not available to the app, like `df`) | ≥ `warn_percent` / ≥ `fail_percent` |
| `storage` | Writes, reads and removes a probe file in each folder, and optionally on a storage disk | — / any folder or disk not writable |
| `app-key` | `APP_KEY` and `APP_PREVIOUS_KEYS`, using the framework's own key rules | — / missing or weak (the value is never shown) |
| `debug-mode` | `APP_DEBUG` per environment | on in staging / on in production |
| `environment` | Every key in `.env.example` is defined (names only, never values) | — / missing, or empty when listed in `required` |
| heartbeats | Age of the last `recordHeartbeat()` call | older than 120 s / older than 600 s |

The migrations check compares names only. `node strut migrate:status` also verifies checksums, but it replays every migration in a sandbox, which is too heavy for a check that may run every minute.

## Custom checks

```ts
import { defineCheck, HealthToken, Result } from '@strutvane/health'
import { HttpClientToken } from '@strutvane/framework'

export const paymentsApi = defineCheck({
  name: 'payments-api',            // lowercase kebab-case, unique
  label: 'Payments API',
  timeoutMs: 3000,                 // optional; the default is timeout_ms
  async run({ make }) {
    const response = await make(HttpClientToken).timeout(2000).get('https://api.example.com/status')
    return response.ok ? Result.ok(`HTTP ${response.status}`) : Result.failed(`HTTP ${response.status}`)
  },
})

// app/providers/app.provider.ts
override boot(app: Application): void {
  app.make(HealthToken).register(paymentsApi)
  // Replace a built-in check with your own settings:
  // app.make(HealthToken).forget('disk-space').register(diskSpaceCheck({ failPercent: 95 }))
}
```

A check gets `basePath`, `environment`, `env`, `make`/`has` (the container), `config(path)`, `now()` and an `AbortSignal` that fires at its deadline. The runner takes care of the failure cases for you:

- A thrown error becomes `failed`, with its message and code but never its stack.
- A check that hangs fails at its deadline.
- A malformed result is reported as `failed`.

### Heartbeats (scheduler, queues)

```ts
import { recordHeartbeat } from '@strutvane/health'
await recordHeartbeat(app.make(CacheManagerToken).store(), 'scheduler', Date.now())   // on every tick
```

List the name under `checks.heartbeats` in the config, or register `heartbeatCheck({ heartbeat: 'scheduler' })` yourself. The framework's scheduler and queue will call `recordHeartbeat` once they ship.

## Alerts

- **Slack** (`HEALTH_SLACK_WEBHOOK_URL`): the host must be `hooks.slack.com`.
- **Webhook** (`HEALTH_WEBHOOK_URL`, optional `HEALTH_WEBHOOK_SECRET`): HTTPS only. With a secret, every body is signed: `x-health-signature: sha256=<hex HMAC of "<x-health-timestamp>.<body>">`. Verify it with `signature(secret, timestamp, body)`.
- **Mail** (`HEALTH_MAIL_TO`): the framework's mailer isn't released yet, so bind a transport:

  ```ts
  app.container.value(HealthMailerToken, { send: (mail) => myMailer.send(mail) })
  ```

How alerts behave:

- **Throttling:** each check and status alerts at most once per `throttle_minutes`. The throttle is claimed with the cache's atomic `add`, so two servers never both send. A check going from warning to failed alerts at once.
- **Recovery:** a check that alerted sends one recovery message when it is ok again.
- **SSRF:** alerts go through the framework's `HttpClient`, so private, loopback and metadata addresses are refused, even after DNS resolution or a redirect.
- **Isolation:** one broken channel never blocks the others.
- **Logging:** delivery errors are logged by channel name and error code only. Webhook URLs are secrets and are never logged.

## Security model

- **Secrets never leave the runner.** Every result is sanitized before it is stored, served, printed or sent:
  - values of env variables with sensitive names (`*_PASSWORD`, `*_KEY`, `*_TOKEN`, `*_SECRET`, …) are masked;
  - credentials in URLs are masked;
  - `Bearer …` and `password=…` patterns are masked;
  - sensitive meta keys are dropped;
  - control characters are stripped and lengths are bounded.
- **The endpoint is closed by default.** It needs a token or a policy (`404` without either, `401` for a wrong token, `429` after repeated failures). It shows no meta, and messages only on opt-in.
- **Config paths can't escape the app.** `..` and absolute paths are refused. Probe files are random, created exclusively (`wx`) and always removed.
- **History rows are data.** Every query binds its values. Stored meta is parsed defensively, so `__proto__` keys are dropped.

## API

The package exports:

- `@strutvane/health`: the checks, `defineCheck`, `Result`, `Health`/`HealthToken`, the stores, channels, `Notifier`, the sanitizer and `resolveHealthSettings`.
- `/provider`: `HealthServiceProvider`, `HealthEnvToken` and `HealthMailerToken`.
- `/commands`: the CLI commands.
- `/installer`: the installer.

Every export has TSDoc with an example.

## Development

```bash
npm ci
npm run ci     # biome → tsc → vitest (coverage 90/90/85/90) → tsdown
```

The tests run on real engines:

- SQLite (`node:sqlite`) through the framework's driver;
- the shipped migration through the framework's sandbox and runner;
- a real booted `Application` for the endpoint;
- the framework's CLI runner for the commands;
- the devkit installer on a skeleton-shaped app.
