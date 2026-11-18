/**
 * The `Health` service: the registered checks, and running them.
 *
 * One instance per app, bound under {@link HealthToken} by the provider. Apps add their own
 * checks in a provider's `boot()`:
 *
 * ```ts
 * app.make(HealthToken).register(paymentsApi, queueDepth)
 * ```
 *
 * `run()` is what the CLI uses: it runs, stores the report in history and sends alerts.
 * `current()` is what the JSON endpoint uses: it reuses a report younger than `maxAgeMs` and
 * joins a run already in progress (single flight), so a burst of monitor requests can't turn the
 * health endpoint into a way to hammer the database.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { BootError, type HttpContext } from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import { type Token, token } from '@strutvane/framework/core'
import { type CheckContext, checkProblem, type HealthCheck } from './check.ts'
import type { ResultStore } from './history/store.ts'
import type { Notifier, NotifyOutcome } from './notify/notifier.ts'
import { createReport, type HealthReport } from './report.ts'
import { DEFAULT_CHECK_TIMEOUT_MS, runChecks } from './runner.ts'
import { sanitizeText, secretValues } from './sanitize.ts'

/**
 * What the `Health` service needs from the app.
 *
 * @example
 * new Health({ context: (signal) => ({ …, signal }), env: process.env, now: Date.now, logger })
 */
export interface HealthOptions {
  /** Builds a check's context (the provider wires the app's container, config and clock). */
  readonly context: (signal: AbortSignal) => CheckContext
  /** The environment, for masking secret values in results. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly now: () => number
  readonly logger: Logger
  /** Default per-check deadline (ms). */
  readonly timeoutMs?: number
  /** Results history; omit to keep none. */
  readonly store?: ResultStore
  /** Alerts; omit to send none. */
  readonly notifier?: Notifier
  /** Delete history older than this many days after each stored run. Default 7. */
  readonly keepDays?: number
}

/**
 * Options of {@link Health.run}.
 *
 * @example
 * await health.run({ only: ['database'], store: false })
 */
export interface RunOptions {
  /** Run only these checks (by name). Unknown names throw, listing the known ones. */
  readonly only?: readonly string[]
  /** Store the report in history (when a store is configured). Default true. */
  readonly store?: boolean
  /** Send alerts (when channels are configured). Default true. */
  readonly notify?: boolean
}

/**
 * A run's report, plus what happened to it.
 *
 * @example
 * const { report, stored, notified } = await health.run()
 */
export interface RunOutcome {
  readonly report: HealthReport
  readonly stored: boolean
  /** `undefined` when no alerts were attempted. */
  readonly notified: NotifyOutcome | undefined
  /** Problems with history or alerts (never secrets); the report itself is still valid. */
  readonly problems: readonly string[]
}

/**
 * Decides whether a request may read the JSON endpoint without the token (your policy). Return
 * `true` to allow. A thrown error denies.
 *
 * @example
 * const admins: HealthAuthorizer = (ctx) => ctx.user?.role === 'admin'
 */
export type HealthAuthorizer = (ctx: HttpContext) => boolean | Promise<boolean>

/**
 * The container token the provider binds the service under.
 *
 * @example
 * app.make(HealthToken).register(myCheck)
 */
export const HealthToken: Token<Health> = token<Health>('strutvane.health')

/**
 * The registered checks and how to run them (see the module docs).
 *
 * @example
 * const report = (await app.make(HealthToken).run()).report
 */
export class Health {
  readonly #checks = new Map<string, HealthCheck>()
  readonly #options: HealthOptions
  readonly #secrets: readonly string[]
  #inFlight: Promise<HealthReport> | undefined
  #last: { readonly report: HealthReport; readonly at: number } | undefined
  #authorizer: HealthAuthorizer | undefined

  constructor(options: HealthOptions) {
    this.#options = options
    this.#secrets = secretValues(options.env)
  }

  /**
   * Add checks. Names must be unique: registering a second `database` check is a mistake that
   * would hide one of them, so it throws instead of replacing.
   *
   * @example
   * health.register(databaseCheck({ name: 'replica', connection: ReplicaToken }))
   */
  register(...checks: readonly HealthCheck[]): this {
    for (const check of checks) {
      const problem = checkProblem(check)
      if (problem !== undefined)
        throw new BootError(
          'invalid_health_check',
          `Invalid health check: ${problem}.`,
          'Create checks with defineCheck({ name, run }).',
        )
      if (this.#checks.has(check.name))
        throw new BootError(
          'duplicate_health_check',
          `A health check named "${check.name}" is already registered.`,
          'Give the second one another name, for example databaseCheck({ name: "replica" }).',
        )
      this.#checks.set(check.name, check)
    }
    return this
  }

  /**
   * Remove a check (to replace a default one with your own settings).
   *
   * @example
   * health.forget('disk-space').register(diskSpaceCheck({ failPercent: 95 }))
   */
  forget(name: string): this {
    this.#checks.delete(name)
    return this
  }

  /**
   * Let requests your policy allows read the JSON endpoint (in addition to the token). Call it in
   * a provider's `boot()`; the last call wins.
   *
   * @example
   * app.make(HealthToken).authorizeUsing((ctx) => ctx.user?.role === 'admin')
   */
  authorizeUsing(authorizer: HealthAuthorizer): this {
    this.#authorizer = authorizer
    return this
  }

  /** The policy set with {@link authorizeUsing}, if any. */
  get authorizer(): HealthAuthorizer | undefined {
    return this.#authorizer
  }

  /** The registered checks, in registration order. */
  list(): readonly HealthCheck[] {
    return [...this.#checks.values()]
  }

  /** The history store, when one is configured. */
  get store(): ResultStore | undefined {
    return this.#options.store
  }

  /**
   * Run the checks, store the report and send alerts. Never throws for a failing check: failures
   * are in the report. History and alert problems are returned in `problems`.
   *
   * @example
   * const { report } = await health.run()
   * if (report.status === 'failed') process.exitCode = 1
   */
  async run(options: RunOptions = {}): Promise<RunOutcome> {
    const report = await this.#runChecks(this.#select(options.only))
    const problems: string[] = []
    let stored = false
    const store = this.#options.store
    if (store !== undefined && options.store !== false) {
      try {
        await store.save(report)
        stored = true
        const keepDays = this.#options.keepDays ?? 7
        await store.prune(this.#options.now() - keepDays * 86_400_000)
      } catch (error) {
        problems.push(`history: ${this.#describe(error)}`)
        this.#options.logger.warn('health: could not store the results', {
          error: this.#describe(error),
        })
      }
    }
    let notified: NotifyOutcome | undefined
    if (this.#options.notifier !== undefined && options.notify !== false) {
      notified = await this.#options.notifier.notify(report)
      for (const channel of notified.failedChannels) problems.push(`alerts: ${channel} failed`)
    }
    return { report, stored, notified, problems }
  }

  /**
   * A fresh-enough report for the endpoint: the last one if it is younger than `maxAgeMs`,
   * otherwise a new run (joined by concurrent callers). Not stored and no alerts: the endpoint is
   * read-only; scheduled `health:check` runs own history and alerts.
   *
   * @example
   * const report = await health.current(10_000)
   */
  async current(maxAgeMs: number): Promise<HealthReport> {
    const last = this.#last
    if (last !== undefined && this.#options.now() - last.at < maxAgeMs) return last.report
    this.#inFlight ??= this.#runChecks(this.list()).finally(() => {
      this.#inFlight = undefined
    })
    return this.#inFlight
  }

  /** An error's message, sanitized and bounded (history errors are shown by the CLI). */
  #describe(error: unknown): string {
    const text = error instanceof Error ? error.message : describe(error)
    return sanitizeText(text, this.#secrets, 300)
  }

  async #runChecks(checks: readonly HealthCheck[]): Promise<HealthReport> {
    const runs = await runChecks(checks, {
      context: this.#options.context,
      timeoutMs: this.#options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      secrets: this.#secrets,
      now: this.#options.now,
    })
    const at = this.#options.now()
    const report = createReport(randomUUID(), at, runs)
    this.#last = { report, at }
    return report
  }

  #select(only: readonly string[] | undefined): readonly HealthCheck[] {
    if (only === undefined || only.length === 0) return this.list()
    const unknown = only.filter((name) => !this.#checks.has(name))
    if (unknown.length > 0) throw new UnknownCheckError(unknown, [...this.#checks.keys()])
    return only.flatMap((name) => {
      const check = this.#checks.get(name)
      return check === undefined ? [] : [check]
    })
  }
}

/**
 * `--only` named a check that does not exist.
 *
 * @example
 * if (error instanceof UnknownCheckError) error.unknown // ['databse']
 */
export class UnknownCheckError extends Error {
  readonly unknown: readonly string[]
  readonly known: readonly string[]

  constructor(unknown: readonly string[], known: readonly string[]) {
    super(
      `Unknown health check(s): ${unknown.join(', ')}. Registered: ${known.join(', ') || 'none'}.`,
    )
    this.name = 'UnknownCheckError'
    this.unknown = unknown
    this.known = known
  }
}

function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') return code
    if (error instanceof Error) return error.name
  }
  return 'unknown error'
}
