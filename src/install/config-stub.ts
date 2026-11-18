/**
 * The `config/health.ts` the installer writes. Plain data read from `.env`, so it can be cached
 * with `node strut config:cache`; checks themselves are registered in code (see the README).
 *
 * @module
 */

/** Where the installer writes the config file, relative to the app root. */
export const CONFIG_PATH = 'config/health.ts'

/**
 * The config file's source.
 *
 * @example
 * await fs.write(CONFIG_PATH, CONFIG_SOURCE)
 */
export const CONFIG_SOURCE: string = `// Health checks (@strutvane/health). Every value has a safe default; delete what you don't change.
//
// Run the checks with \`node strut health:check\` (schedule it every few minutes: it stores history
// and sends alerts). Monitors read GET /health.json with the token below; /up stays the public
// liveness probe. Add your own checks in a provider: app.make(HealthToken).register(myCheck).
import { defineConfig } from '@strutvane/framework'

export default defineConfig((env) => ({
  /** Per-check deadline in milliseconds. A check that takes longer is reported as failed. */
  timeout_ms: 5000,

  endpoint: {
    /** Serve GET /health.json. It answers 404 until a token (or a policy) is configured. */
    enabled: true,
    path: '/health.json',
    /**
     * Monitors send it as \`Authorization: Bearer <token>\`. At least 32 characters; the installer
     * wrote a random one into .env. Empty turns token access off.
     */
    token: env.string('HEALTH_CHECK_TOKEN', ''),
    /** Include each check's message in the JSON (summaries are always included). */
    expose_messages: false,
    /** Reuse a report this many seconds, so the endpoint can't be used to hammer the database. */
    cache_seconds: 10,
    /** Wrong tokens allowed per client IP per minute before the endpoint answers 429. */
    max_failed_attempts: 10,
  },

  history: {
    /** Keep results in the health_check_results table (created by the installer's migration). */
    enabled: true,
    keep_days: 7,
  },

  checks: {
    database: { enabled: true, warn_ms: 100, fail_ms: 1000 },
    migrations: { enabled: true },
    cache: { enabled: true },
    disk_space: { enabled: true, path: 'storage', warn_percent: 70, fail_percent: 90 },
    storage: { enabled: true, paths: ['storage/framework', 'storage/logs'] },
    app_key: { enabled: true },
    debug_mode: { enabled: true },
    environment: { enabled: true, ignore: [], required: [] },
    /** Background processes that call recordHeartbeat(), e.g. ['scheduler', 'queue:default']. */
    heartbeats: [],
  },

  notifications: {
    /** The lowest status that sends an alert: 'failed' or 'warning'. */
    on: 'failed',
    /** At most one alert per check and status in this many minutes. */
    throttle_minutes: 60,
    /** Say so when a check that alerted is healthy again. */
    recovery: true,
    /** A Slack incoming-webhook URL (https://hooks.slack.com/...). Keep it in .env: it is a secret. */
    slack_webhook_url: env.string('HEALTH_SLACK_WEBHOOK_URL', ''),
    /** Any HTTPS endpoint; with a secret, every alert is signed (x-health-signature). */
    webhook_url: env.string('HEALTH_WEBHOOK_URL', ''),
    webhook_secret: env.string('HEALTH_WEBHOOK_SECRET', ''),
    /** Comma-separated addresses; needs a mail transport bound under HealthMailerToken. */
    mail_to: env.string('HEALTH_MAIL_TO', ''),
  },
}))
`
