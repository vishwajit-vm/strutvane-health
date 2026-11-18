/**
 * The custom checks API: what a health check is, and what it can use while it runs.
 *
 * A check is a plain object with a `name` and a `run(context)` function, so writing one needs no
 * base class and no framework internals:
 *
 * ```ts
 * import { defineCheck, Result } from '@strutvane/health'
 *
 * export const paymentsApi = defineCheck({
 *   name: 'payments-api',
 *   label: 'Payments API',
 *   async run({ make, signal }) {
 *     const response = await make(HttpClientToken).timeout(2_000).get('https://api.example.com/status')
 *     return response.ok ? Result.ok() : Result.failed(`HTTP ${response.status}`)
 *   },
 * })
 * ```
 *
 * The runner gives every check a timeout (an `AbortSignal` too), turns a thrown error into a
 * `failed` result, and removes secrets from what the check returns, so one broken check can never
 * hang `health:check` or leak a password into Slack.
 *
 * @module
 */
import { BootError } from '@strutvane/framework'
import type { Token } from '@strutvane/framework/core'
import type { CheckResult } from './result.ts'

/**
 * What a check can use while it runs. Built fresh for every run by the {@link Health} service.
 *
 * @example
 * async run({ make, environment }) { … }
 */
export interface CheckContext {
  /** The app's root folder (where `.env`, `storage/` and `database/` live). */
  readonly basePath: string
  /** `APP_ENV`: `local`, `testing`, `staging` or `production`. */
  readonly environment: string
  /** The environment variables the app booted with (`.env` + the process). Never log them. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Resolve a service from the app's container (the database connection, the cache…). */
  make<TValue>(key: Token<TValue>): TValue
  /** `true` when the container can resolve `key`. */
  has(key: Token<unknown>): boolean
  /** A config value by dotted path (`app.debug`), or `undefined` when unset. */
  config(path: string): unknown
  /** Milliseconds since the epoch, from the app's clock (tests freeze it). */
  now(): number
  /** Aborted when the check runs out of time; pass it to anything that accepts one. */
  readonly signal: AbortSignal
}

/**
 * A health check. Create one with {@link defineCheck}, which validates the name.
 *
 * @example
 * const check: HealthCheck = { name: 'queue', run: () => Result.ok() }
 */
export interface HealthCheck {
  /** Unique, lowercase kebab-case: `database`, `disk-space`, `payments-api`. */
  readonly name: string
  /** Shown to people; defaults to the name. */
  readonly label?: string
  /** Overrides the runner's timeout for this check (milliseconds). */
  readonly timeoutMs?: number
  /** Do the check. Throwing is fine: the runner reports it as `failed`. */
  run(context: CheckContext): CheckResult | Promise<CheckResult>
}

/** Check names: lowercase words joined by `-`, up to 64 characters. */
export const CHECK_NAME: RegExp = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Longest accepted check name (it is a column in the history table). */
export const MAX_CHECK_NAME_LENGTH = 64

/** Longest accepted label (it is stored in history and shown in alerts). */
export const MAX_LABEL_LENGTH = 100

/** Longest timeout a check may ask for: a health check that needs longer is a job, not a check. */
export const MAX_CHECK_TIMEOUT_MS = 60_000

/**
 * Why a check definition is unusable, or `undefined` when it is fine.
 *
 * @example
 * checkProblem({ name: 'Bad Name', run: () => Result.ok() }) // 'name "Bad Name" must be …'
 */
export function checkProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'a check must be an object'
  const check = value as Readonly<Record<string, unknown>>
  const name = check['name']
  if (typeof name !== 'string' || !CHECK_NAME.test(name) || name.length > MAX_CHECK_NAME_LENGTH)
    return `name ${JSON.stringify(name)} must be lowercase kebab-case (like "disk-space"), at most ${MAX_CHECK_NAME_LENGTH} characters`
  const label = check['label']
  if (
    label !== undefined &&
    (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL_LENGTH)
  )
    return `check "${name}": label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`
  const timeout = check['timeoutMs']
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > MAX_CHECK_TIMEOUT_MS)
  )
    return `check "${name}": timeoutMs must be a whole number from 1 to ${MAX_CHECK_TIMEOUT_MS}`
  if (typeof check['run'] !== 'function') return `check "${name}": run must be a function`
  return undefined
}

/**
 * Define a custom check. Validates it immediately, so a typo fails at boot with a clear message
 * instead of at 3 a.m. during an incident.
 *
 * @example
 * export const queueDepth = defineCheck({
 *   name: 'queue-depth',
 *   run: async ({ make }) => ((await countJobs(make)) > 1000 ? Result.warning('backlog') : Result.ok()),
 * })
 */
export function defineCheck<TCheck extends HealthCheck>(check: TCheck): TCheck {
  const problem = checkProblem(check)
  if (problem !== undefined)
    throw new BootError(
      'invalid_health_check',
      `Invalid health check: ${problem}.`,
      'Fix the defineCheck({ … }) call; see the custom checks section of the @strutvane/health README.',
    )
  return check
}

/**
 * The label a check is shown with.
 *
 * @example
 * checkLabel({ name: 'disk-space', run }) // 'disk-space'
 */
export function checkLabel(check: Pick<HealthCheck, 'name' | 'label'>): string {
  return check.label ?? check.name
}
