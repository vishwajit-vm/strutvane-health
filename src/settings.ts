/**
 * `config/health.ts`: the package's settings, as plain data.
 *
 * Settings are plain data (no functions, no check objects) because config files may be cached
 * (`node strut config:cache`) and are read by tools. Checks are code, so they are registered in
 * code: the provider builds the built-in checks from these settings, and apps add custom checks
 * in a provider (`app.make(HealthToken).register(...)`), like Spatie's `Health::checks()`.
 *
 * Every value is validated at boot; problems are reported together in one `BootError`, each with
 * the key to fix. Secrets (the endpoint token, webhook URLs) are read from the environment by the
 * config file and are never echoed in an error.
 *
 * @module
 */
import { BootError } from '@strutvane/framework'

/**
 * The resolved settings (defaults filled in).
 *
 * @example
 * const settings = resolveHealthSettings(app.config('health'))
 */
export interface HealthSettings {
  /** Per-check deadline (ms). */
  readonly timeoutMs: number
  readonly endpoint: {
    readonly enabled: boolean
    readonly path: string
    /** The bearer token monitors send; empty means "token access off". */
    readonly token: string
    /** Include check messages in the JSON (summaries are always included). */
    readonly exposeMessages: boolean
    /** Reuse a report younger than this for endpoint requests. */
    readonly cacheSeconds: number
    /** Failed token attempts allowed per client IP per minute before 429. */
    readonly maxFailedAttempts: number
  }
  readonly history: { readonly enabled: boolean; readonly keepDays: number }
  readonly checks: {
    readonly database: {
      readonly enabled: boolean
      readonly warnMs: number
      readonly failMs: number
    }
    readonly migrations: { readonly enabled: boolean }
    readonly cache: { readonly enabled: boolean; readonly store: string | undefined }
    readonly diskSpace: {
      readonly enabled: boolean
      readonly path: string
      readonly warnPercent: number
      readonly failPercent: number
    }
    readonly storage: {
      readonly enabled: boolean
      readonly paths: readonly string[]
      readonly disk: string | undefined
    }
    readonly appKey: { readonly enabled: boolean }
    readonly debugMode: { readonly enabled: boolean }
    readonly environment: {
      readonly enabled: boolean
      readonly ignore: readonly string[]
      readonly required: readonly string[]
    }
    readonly heartbeats: readonly string[]
  }
  readonly notifications: {
    readonly on: 'warning' | 'failed'
    readonly throttleMinutes: number
    readonly recovery: boolean
    readonly slackWebhookUrl: string
    readonly webhookUrl: string
    readonly webhookSecret: string
    readonly mailTo: readonly string[]
  }
}

/** The shortest endpoint token accepted: 32 characters (`node strut add health` writes 43). */
export const MIN_TOKEN_LENGTH = 32

/** The public liveness probe the framework owns; the health endpoint must never take it. */
const LIVENESS_PATH = '/up'

/**
 * Read and validate `config('health')`. Missing keys get defaults; a missing config file means
 * all defaults (endpoint token access off, so the endpoint answers nobody until configured).
 *
 * @example
 * resolveHealthSettings({ endpoint: { token: process.env.HEALTH_CHECK_TOKEN } })
 */
export function resolveHealthSettings(raw: unknown): HealthSettings {
  const problems: string[] = []
  const root = section(raw, 'health', problems)
  const endpoint = section(root['endpoint'], 'health.endpoint', problems)
  const history = section(root['history'], 'health.history', problems)
  const checks = section(root['checks'], 'health.checks', problems)
  const notifications = section(root['notifications'], 'health.notifications', problems)
  const read = reader(problems)

  const database = section(checks['database'], 'health.checks.database', problems)
  const disk = section(checks['disk_space'], 'health.checks.disk_space', problems)
  const storage = section(checks['storage'], 'health.checks.storage', problems)
  const cache = section(checks['cache'], 'health.checks.cache', problems)
  const environment = section(checks['environment'], 'health.checks.environment', problems)

  const token = read.string(endpoint, 'token', 'health.endpoint.token', '')
  if (token !== '' && token.length < MIN_TOKEN_LENGTH)
    problems.push(
      `health.endpoint.token (HEALTH_CHECK_TOKEN) is too short: at least ${MIN_TOKEN_LENGTH} characters of random text are needed (\`node strut add health\` writes one into .env)`,
    )
  const path = read.string(endpoint, 'path', 'health.endpoint.path', '/health.json')
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(path) || path.includes('//') || path.includes('..'))
    problems.push(`health.endpoint.path "${path}" must be a plain path starting with /`)
  if (path.replace(/\/+$/, '') === LIVENESS_PATH)
    problems.push(
      `health.endpoint.path must not be ${LIVENESS_PATH}: that is the framework's public liveness probe`,
    )

  const settings: HealthSettings = {
    timeoutMs: read.integer(root, 'timeout_ms', 'health.timeout_ms', 5_000, 100, 60_000),
    endpoint: {
      enabled: read.boolean(endpoint, 'enabled', 'health.endpoint.enabled', true),
      path,
      token,
      exposeMessages: read.boolean(
        endpoint,
        'expose_messages',
        'health.endpoint.expose_messages',
        false,
      ),
      cacheSeconds: read.integer(
        endpoint,
        'cache_seconds',
        'health.endpoint.cache_seconds',
        10,
        0,
        3_600,
      ),
      maxFailedAttempts: read.integer(
        endpoint,
        'max_failed_attempts',
        'health.endpoint.max_failed_attempts',
        10,
        1,
        1_000,
      ),
    },
    history: {
      enabled: read.boolean(history, 'enabled', 'health.history.enabled', true),
      keepDays: read.integer(history, 'keep_days', 'health.history.keep_days', 7, 1, 3_650),
    },
    checks: {
      database: {
        enabled: read.boolean(database, 'enabled', 'health.checks.database.enabled', true),
        warnMs: read.integer(
          database,
          'warn_ms',
          'health.checks.database.warn_ms',
          100,
          0,
          600_000,
        ),
        failMs: read.integer(
          database,
          'fail_ms',
          'health.checks.database.fail_ms',
          1_000,
          0,
          600_000,
        ),
      },
      migrations: {
        enabled: read.boolean(
          section(checks['migrations'], 'health.checks.migrations', problems),
          'enabled',
          'health.checks.migrations.enabled',
          true,
        ),
      },
      cache: {
        enabled: read.boolean(cache, 'enabled', 'health.checks.cache.enabled', true),
        store: optional(read.string(cache, 'store', 'health.checks.cache.store', '')),
      },
      diskSpace: {
        enabled: read.boolean(disk, 'enabled', 'health.checks.disk_space.enabled', true),
        path: read.string(disk, 'path', 'health.checks.disk_space.path', 'storage'),
        warnPercent: read.integer(
          disk,
          'warn_percent',
          'health.checks.disk_space.warn_percent',
          70,
          0,
          100,
        ),
        failPercent: read.integer(
          disk,
          'fail_percent',
          'health.checks.disk_space.fail_percent',
          90,
          0,
          100,
        ),
      },
      storage: {
        enabled: read.boolean(storage, 'enabled', 'health.checks.storage.enabled', true),
        paths: read.strings(storage, 'paths', 'health.checks.storage.paths', [
          'storage/framework',
          'storage/logs',
        ]),
        disk: optional(read.string(storage, 'disk', 'health.checks.storage.disk', '')),
      },
      appKey: {
        enabled: read.boolean(
          section(checks['app_key'], 'health.checks.app_key', problems),
          'enabled',
          'health.checks.app_key.enabled',
          true,
        ),
      },
      debugMode: {
        enabled: read.boolean(
          section(checks['debug_mode'], 'health.checks.debug_mode', problems),
          'enabled',
          'health.checks.debug_mode.enabled',
          true,
        ),
      },
      environment: {
        enabled: read.boolean(environment, 'enabled', 'health.checks.environment.enabled', true),
        ignore: read.strings(environment, 'ignore', 'health.checks.environment.ignore', []),
        required: read.strings(environment, 'required', 'health.checks.environment.required', []),
      },
      heartbeats: read.strings(checks, 'heartbeats', 'health.checks.heartbeats', []),
    },
    notifications: {
      on: read.oneOf(
        notifications,
        'on',
        'health.notifications.on',
        ['failed', 'warning'],
        'failed',
      ),
      throttleMinutes: read.integer(
        notifications,
        'throttle_minutes',
        'health.notifications.throttle_minutes',
        60,
        1,
        10_080,
      ),
      recovery: read.boolean(notifications, 'recovery', 'health.notifications.recovery', true),
      slackWebhookUrl: read.string(
        notifications,
        'slack_webhook_url',
        'health.notifications.slack_webhook_url',
        '',
      ),
      webhookUrl: read.string(notifications, 'webhook_url', 'health.notifications.webhook_url', ''),
      webhookSecret: read.string(
        notifications,
        'webhook_secret',
        'health.notifications.webhook_secret',
        '',
      ),
      mailTo: read
        .string(notifications, 'mail_to', 'health.notifications.mail_to', '')
        .split(',')
        .map((address) => address.trim())
        .filter((address) => address !== ''),
    },
  }
  if (settings.checks.database.warnMs > settings.checks.database.failMs)
    problems.push('health.checks.database.warn_ms must not be above fail_ms')
  if (settings.checks.diskSpace.warnPercent > settings.checks.diskSpace.failPercent)
    problems.push('health.checks.disk_space.warn_percent must not be above fail_percent')
  if (problems.length > 0)
    throw new BootError(
      'invalid_health_config',
      `config/health.ts has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`,
      'Fix the values in config/health.ts or the HEALTH_* variables in .env.',
    )
  return settings
}

type Section = Readonly<Record<string, unknown>>

function section(value: unknown, path: string, problems: string[]): Section {
  if (value === undefined || value === null) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Section
  problems.push(`${path} must be an object`)
  return {}
}

function optional(value: string): string | undefined {
  return value === '' ? undefined : value
}

function reader(problems: string[]) {
  return {
    string(from: Section, key: string, path: string, fallback: string): string {
      const value = from[key]
      if (value === undefined || value === null) return fallback
      if (typeof value === 'string') return value.trim()
      problems.push(`${path} must be a string`)
      return fallback
    },
    boolean(from: Section, key: string, path: string, fallback: boolean): boolean {
      const value = from[key]
      if (value === undefined || value === null) return fallback
      if (typeof value === 'boolean') return value
      problems.push(`${path} must be true or false`)
      return fallback
    },
    integer(
      from: Section,
      key: string,
      path: string,
      fallback: number,
      min: number,
      max: number,
    ): number {
      const value = from[key]
      if (value === undefined || value === null) return fallback
      if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)
        return value
      problems.push(`${path} must be a whole number from ${min} to ${max}`)
      return fallback
    },
    strings(
      from: Section,
      key: string,
      path: string,
      fallback: readonly string[],
    ): readonly string[] {
      const value = from[key]
      if (value === undefined || value === null) return fallback
      if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
        return value.map((entry: string) => entry.trim()).filter((entry) => entry !== '')
      problems.push(`${path} must be a list of strings`)
      return fallback
    },
    oneOf<const TValue extends string>(
      from: Section,
      key: string,
      path: string,
      choices: readonly TValue[],
      fallback: TValue,
    ): TValue {
      const value = from[key]
      if (value === undefined || value === null) return fallback
      const match = choices.find((choice) => choice === value)
      if (match !== undefined) return match
      problems.push(`${path} must be one of: ${choices.join(', ')}`)
      return fallback
    },
  }
}
