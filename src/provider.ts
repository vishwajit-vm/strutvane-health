/**
 * `@strutvane/health/provider`: wires health checks into an app.
 *
 * `node strut add health` lists {@link HealthServiceProvider} in `bootstrap/providers.ts`. It:
 * - reads `config/health.ts` (validated; a bad value stops the boot with the key to fix);
 * - binds the {@link Health} service under `HealthToken`, with the built-in checks, the history
 *   store (the `health_check_results` table) and the notifier (Slack, webhook) from the settings;
 * - adds `GET /health.json` (token or policy only; see `http/endpoint.ts`) in the `api` group;
 *
 * The `health:check` and `health:list` commands come from package.json `strutvane.commands`: the
 * CLI finds them without booting the app, and they boot it themselves.
 *
 * Everything is resolved lazily: an app that never runs a check never opens a connection.
 *
 * Add your own checks in your provider's `boot()`:
 *
 * ```ts
 * override boot(app: Application): void {
 *   app.make(HealthToken).register(paymentsApi).authorizeUsing((ctx) => ctx.user?.role === 'admin')
 * }
 * ```
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import {
  type Application,
  CacheManagerToken,
  type CacheStore,
  DatabaseConnectionToken,
  defineRoutes,
  HttpClientToken,
  Route,
  ServiceProvider,
} from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import { ClockToken, LoggerToken, type Token, token } from '@strutvane/framework/core'
import type { CheckContext } from './check.ts'
import { builtInChecks } from './checks/built-in.ts'
import { Health, HealthToken } from './health.ts'
import { DatabaseResultStore } from './history/store.ts'
import { healthEndpoint } from './http/endpoint.ts'
import {
  mailChannel,
  type NotificationChannel,
  slackChannel,
  webhookChannel,
} from './notify/channels.ts'
import { Notifier } from './notify/notifier.ts'
import { type HealthSettings, resolveHealthSettings } from './settings.ts'

/**
 * The environment health checks see. Bound by tests (and apps that boot with an explicit `env`);
 * otherwise `.env` plus the process environment, like the framework reads it.
 *
 * @example
 * app.container.value(HealthEnvToken, { APP_ENV: 'testing', APP_KEY: key })
 */
export const HealthEnvToken: Token<Readonly<Record<string, string | undefined>>> =
  token<Readonly<Record<string, string | undefined>>>('strutvane.health.env')

/**
 * Sends health alerts by mail. Bind one to enable `notifications.mail_to` (the framework's
 * mailer is not released yet, so the transport is yours).
 *
 * @example
 * app.container.value(HealthMailerToken, { send: (mail) => myMailer.send(mail) })
 */
export const HealthMailerToken: Token<{
  send(mail: { to: readonly string[]; subject: string; text: string }): Promise<void>
}> = token('strutvane.health.mailer')

/**
 * The service provider (see the module docs).
 *
 * @example
 * // bootstrap/providers.ts
 * const providers: readonly AnyProvider[] = [AppServiceProvider, HealthServiceProvider]
 */
export class HealthServiceProvider extends ServiceProvider {
  override register(app: Application): void {
    const repository = app.configRepository
    const settings = resolveHealthSettings(
      repository.has('health') ? repository.get('health') : undefined,
    )
    app.container.singleton(HealthToken, () => createHealth(app, settings))
    if (!settings.endpoint.enabled) return
    const handler = healthEndpoint({
      health: () => app.make(HealthToken),
      token: settings.endpoint.token,
      exposeMessages: settings.endpoint.exposeMessages,
      cacheSeconds: settings.endpoint.cacheSeconds,
      maxFailedAttempts: settings.endpoint.maxFailedAttempts,
      cache: () => defaultStore(app),
      logger: () => app.make(LoggerToken),
    })
    app.addRoutes(defineRoutes([Route.get(settings.endpoint.path, handler).name('health.json')]), {
      group: 'api',
    })
  }
}

/**
 * Build the `Health` service for a booted app from its settings.
 *
 * @example
 * const health = createHealth(app, resolveHealthSettings(undefined))
 */
export function createHealth(app: Application, settings: HealthSettings): Health {
  const container = app.container
  const env = container.has(HealthEnvToken) ? container.make(HealthEnvToken) : readEnv(app.basePath)
  const clock = container.make(ClockToken)
  const logger: Logger = container.make(LoggerToken)
  const repository = app.configRepository
  const context = (signal: AbortSignal): CheckContext => ({
    basePath: app.basePath,
    environment: app.environment,
    env,
    make: (key) => container.make(key),
    has: (key) => container.has(key),
    config: (path) => (repository.has(path) ? repository.get(path) : undefined),
    now: () => clock.now(),
    signal,
  })
  const notifier = createNotifier(app, settings, logger)
  const health = new Health({
    context,
    env,
    now: () => clock.now(),
    logger,
    timeoutMs: settings.timeoutMs,
    keepDays: settings.history.keepDays,
    ...(settings.history.enabled && container.has(DatabaseConnectionToken)
      ? { store: new DatabaseResultStore(() => container.make(DatabaseConnectionToken)) }
      : {}),
    ...(notifier === undefined ? {} : { notifier }),
  })
  health.register(...builtInChecks(settings))
  return health
}

function createNotifier(
  app: Application,
  settings: HealthSettings,
  logger: Logger,
): Notifier | undefined {
  const { notifications } = settings
  const container = app.container
  const channels: NotificationChannel[] = []
  if (notifications.slackWebhookUrl !== '')
    channels.push(
      slackChannel({ url: notifications.slackWebhookUrl, http: container.make(HttpClientToken) }),
    )
  if (notifications.webhookUrl !== '')
    channels.push(
      webhookChannel({
        url: notifications.webhookUrl,
        http: container.make(HttpClientToken),
        ...(notifications.webhookSecret === '' ? {} : { secret: notifications.webhookSecret }),
      }),
    )
  if (notifications.mailTo.length > 0) {
    if (container.has(HealthMailerToken)) {
      const mailer = container.make(HealthMailerToken)
      channels.push(mailChannel({ to: notifications.mailTo, send: (mail) => mailer.send(mail) }))
    } else
      logger.warn(
        'health: notifications.mail_to is set but no HealthMailerToken is bound; mail alerts are off',
      )
  }
  const cache = defaultStore(app)
  if (channels.length === 0 || cache === undefined) return undefined
  return new Notifier({
    channels,
    cache,
    logger,
    on: notifications.on,
    throttleMinutes: notifications.throttleMinutes,
    recovery: notifications.recovery,
    appName: appName(app),
    environment: app.environment,
  })
}

function defaultStore(app: Application): CacheStore | undefined {
  return app.container.has(CacheManagerToken) ? app.make(CacheManagerToken).store() : undefined
}

function appName(app: Application): string {
  const repository = app.configRepository
  const name = repository.has('app.name') ? repository.get('app.name') : undefined
  return typeof name === 'string' && name.trim() !== '' ? name : 'app'
}

/** `.env` (when present) under the process environment, the framework's precedence. */
function readEnv(basePath: string): Readonly<Record<string, string | undefined>> {
  const file = join(basePath, '.env')
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return { ...fromFile, ...process.env }
}
