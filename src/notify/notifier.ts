/**
 * Deciding when to alert, and not alerting too often.
 *
 * A check that fails every minute must not page someone every minute. The notifier:
 * 1. picks the checks at or above the alert level (`failed` by default, or `warning`);
 * 2. for each one, alerts at most once per `throttleMinutes` **per check and status**: the first
 *    process to claim the slot with the cache's atomic `add` wins, so two servers (or a cron run
 *    overlapping a web request) never both send. A check going from warning to failed alerts
 *    again at once: that is news;
 * 3. after a check that alerted is healthy again, sends one recovery message (optional);
 * 4. delivers to every channel independently: one broken channel (Slack down) never stops the
 *    others, and delivery errors are logged by channel name and error code only (never the URL,
 *    which is a secret, and never the response body).
 *
 * The rate-limit state lives in the app's cache, so it survives restarts with the file store and
 * is shared between servers with a shared store.
 *
 * @module
 */
import type { CacheStore } from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import type { CheckRun, HealthReport } from '../report.ts'
import { severity } from '../result.ts'
import type { HealthNotification, NotificationChannel } from './channels.ts'

/** Cache key prefixes of the notifier's state. */
export const NOTIFY_PREFIX = 'health:notify:'

/**
 * Notifier settings.
 *
 * @example
 * const options: NotifierOptions = { channels, cache, logger, on: 'failed', throttleMinutes: 60, recovery: true, appName: 'Blog', environment: 'production' }
 */
export interface NotifierOptions {
  readonly channels: readonly NotificationChannel[]
  /** Where throttle and "alerted" markers live (the app's default cache store). */
  readonly cache: CacheStore
  readonly logger: Logger
  /** The lowest status that alerts. Default `failed`. */
  readonly on?: 'warning' | 'failed'
  /** Minimum minutes between two alerts for the same check and status. Default 60. */
  readonly throttleMinutes?: number
  /** Send a message when a check that alerted is ok again. Default true. */
  readonly recovery?: boolean
  readonly appName: string
  readonly environment: string
}

/**
 * What one call to {@link Notifier.notify} did (for the CLI and tests).
 *
 * @example
 * const outcome: NotifyOutcome = { alerted: ['database'], recovered: [], suppressed: [], failedChannels: [] }
 */
export interface NotifyOutcome {
  readonly alerted: readonly string[]
  readonly recovered: readonly string[]
  /** Checks still failing, but alerted within the throttle window. */
  readonly suppressed: readonly string[]
  /** Channels whose delivery failed. */
  readonly failedChannels: readonly string[]
}

/** Longest throttle accepted: a week. */
const MAX_THROTTLE_MINUTES = 7 * 24 * 60
/** How long an "alerted" marker lives: long enough to send the recovery after a long outage. */
const ALERTED_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Sends alerts for a report, rate-limited (see the module docs).
 *
 * @example
 * const notifier = new Notifier({ channels: [slack], cache, logger, appName: 'Blog', environment: 'production' })
 * await notifier.notify(report)
 */
export class Notifier {
  readonly #options: NotifierOptions
  readonly #threshold: number
  readonly #throttleSeconds: number

  constructor(options: NotifierOptions) {
    const minutes = options.throttleMinutes ?? 60
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_THROTTLE_MINUTES)
      throw new RangeError(
        `throttleMinutes must be from 1 to ${MAX_THROTTLE_MINUTES} (got ${String(minutes)})`,
      )
    this.#options = options
    this.#threshold = severity(options.on ?? 'failed')
    this.#throttleSeconds = Math.round(minutes * 60)
  }

  /** The channels alerts go to. */
  get channels(): readonly NotificationChannel[] {
    return this.#options.channels
  }

  /**
   * Alert about the checks of `report` that need it. Never throws: delivery problems are logged.
   *
   * @example
   * const { alerted } = await notifier.notify(report)
   */
  async notify(report: HealthReport): Promise<NotifyOutcome> {
    const { cache } = this.#options
    const alerting: CheckRun[] = []
    const suppressed: string[] = []
    const recovered: CheckRun[] = []
    for (const run of report.checks) {
      const alertedKey = `${NOTIFY_PREFIX}alerted:${run.name}`
      if (severity(run.status) >= this.#threshold && run.status !== 'ok') {
        const slot = `${NOTIFY_PREFIX}sent:${run.name}:${run.status}`
        if (await this.#claim(slot)) {
          alerting.push(run)
          await this.#safely(() => cache.put(alertedKey, run.status, ALERTED_TTL_SECONDS))
        } else suppressed.push(run.name)
      } else if (run.status === 'ok' && (await this.#safely(() => cache.forget(alertedKey)))) {
        // The marker existed: this check alerted before and is healthy now. Clear its throttle
        // slots too, so a relapse alerts at once.
        recovered.push(run)
        await this.#safely(() => cache.forget(`${NOTIFY_PREFIX}sent:${run.name}:warning`))
        await this.#safely(() => cache.forget(`${NOTIFY_PREFIX}sent:${run.name}:failed`))
      }
    }
    const failedChannels = new Set<string>()
    if (alerting.length > 0)
      for (const name of await this.#deliver(this.#message(report.status, alerting, false)))
        failedChannels.add(name)
    if (recovered.length > 0 && this.#options.recovery !== false)
      for (const name of await this.#deliver(this.#message('ok', recovered, true)))
        failedChannels.add(name)
    return {
      alerted: alerting.map((run) => run.name),
      recovered: recovered.map((run) => run.name),
      suppressed,
      failedChannels: [...failedChannels],
    }
  }

  /** Claim a throttle slot atomically; a cache error fails open to "send" (an alert beats none). */
  async #claim(key: string): Promise<boolean> {
    try {
      return await this.#options.cache.add(key, 1, this.#throttleSeconds)
    } catch (error) {
      this.#options.logger.warn('health: notification throttle unavailable; sending anyway', {
        error: errorCode(error),
      })
      return true
    }
  }

  async #safely(work: () => Promise<unknown>): Promise<boolean> {
    try {
      return (await work()) === true
    } catch {
      return false
    }
  }

  #message(
    status: 'ok' | 'warning' | 'failed',
    runs: readonly CheckRun[],
    recovery: boolean,
  ): HealthNotification {
    const { appName, environment } = this.#options
    const names = runs.map((run) => run.name).join(', ')
    const headline = recovery ? 'recovered' : status
    return {
      subject: `[${appName}, ${environment}] Health: ${headline} (${names})`,
      text: runs.map((run) => `${run.label}: ${run.status}, ${run.summary}`).join('\n'),
      status: recovery ? 'ok' : status,
      checks: runs.map((run) => ({
        name: run.name,
        label: run.label,
        status: run.status,
        summary: run.summary,
      })),
    }
  }

  /** Send to every channel independently; returns the names of the channels that failed. */
  async #deliver(notification: HealthNotification): Promise<string[]> {
    const outcomes = await Promise.allSettled(
      this.#options.channels.map((channel) => channel.send(notification)),
    )
    const failed: string[] = []
    outcomes.forEach((outcome, index) => {
      const channel = this.#options.channels[index]
      if (outcome.status === 'fulfilled' || channel === undefined) return
      failed.push(channel.name)
      this.#options.logger.warn('health: alert delivery failed', {
        channel: channel.name,
        error: errorCode(outcome.reason),
      })
    })
    return failed
  }
}

/** An error's `code` (or its class name): enough to diagnose, never a URL or a response body. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') return code
    if (error instanceof Error) return error.name
  }
  return 'unknown'
}
