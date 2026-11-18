/**
 * What a health check reports: a status, a one-line summary and optional details.
 *
 * Four statuses, ordered by severity:
 * - `ok`: healthy.
 * - `warning`: still working, but someone should look (latency above the warning threshold, a
 *   disk 75% full). Warnings never fail `node strut health:check` unless `--fail-on warning`.
 * - `failed`: broken (database unreachable, disk 95% full, debug on in production).
 * - `skipped`: the check does not apply here (no cache store configured). It never makes the
 *   overall status worse.
 *
 * @module
 */

/**
 * A check's status.
 *
 * @example
 * const status: HealthStatus = 'warning'
 */
export type HealthStatus = 'ok' | 'warning' | 'failed' | 'skipped'

/** Every status, in severity order (best first). */
export const HEALTH_STATUSES: readonly HealthStatus[] = Object.freeze([
  'ok',
  'skipped',
  'warning',
  'failed',
])

const SEVERITY: Readonly<Record<HealthStatus, number>> = Object.freeze({
  ok: 0,
  skipped: 0,
  warning: 1,
  failed: 2,
})

/**
 * A details value. Plain scalars only, so a result can always be stored as JSON and shown in a
 * table; secrets are removed before a result leaves the runner (see `sanitize.ts`).
 *
 * @example
 * const value: MetaValue = 42
 */
export type MetaValue = string | number | boolean | null

/**
 * Structured details of a result (`latencyMs`, `usedPercent`, …).
 *
 * @example
 * const meta: ResultMeta = { latencyMs: 12 }
 */
export type ResultMeta = Readonly<Record<string, MetaValue>>

/**
 * The outcome of one check run.
 *
 * - `summary` is short and safe to show anywhere (the JSON endpoint, a Slack message): `"12 ms"`,
 *   `"71% used"`.
 * - `message` explains a warning or failure and how to fix it. It is shown by the CLI and stored
 *   in history; the JSON endpoint leaves it out unless `endpoint.expose_messages` is on.
 * - `meta` holds machine-readable details; it is stored but never served by the endpoint.
 *
 * @example
 * const result: CheckResult = { status: 'ok', summary: '12 ms', meta: { latencyMs: 12 } }
 */
export interface CheckResult {
  readonly status: HealthStatus
  readonly summary: string
  readonly message?: string
  readonly meta: ResultMeta
}

/**
 * Build a result. One helper per status keeps checks short and the shape consistent.
 *
 * @example
 * return Result.ok('12 ms', { latencyMs: 12 })
 * return Result.failed('unreachable', 'Connection refused. Check DB_HOST and that the server runs.')
 */
export const Result: {
  readonly ok: (summary?: string, meta?: ResultMeta) => CheckResult
  readonly warning: (summary: string, message?: string, meta?: ResultMeta) => CheckResult
  readonly failed: (summary: string, message?: string, meta?: ResultMeta) => CheckResult
  readonly skipped: (summary: string, meta?: ResultMeta) => CheckResult
} = Object.freeze({
  ok: (summary = 'ok', meta: ResultMeta = {}): CheckResult => ({ status: 'ok', summary, meta }),
  warning: (summary: string, message?: string, meta: ResultMeta = {}): CheckResult =>
    withMessage({ status: 'warning', summary, meta }, message),
  failed: (summary: string, message?: string, meta: ResultMeta = {}): CheckResult =>
    withMessage({ status: 'failed', summary, meta }, message),
  skipped: (summary: string, meta: ResultMeta = {}): CheckResult => ({
    status: 'skipped',
    summary,
    meta,
  }),
})

function withMessage(result: CheckResult, message: string | undefined): CheckResult {
  return message === undefined ? result : { ...result, message }
}

/**
 * The severity of a status: 0 for ok and skipped, 1 for warning, 2 for failed.
 *
 * @example
 * severity('warning') // 1
 */
export function severity(status: HealthStatus): number {
  return SEVERITY[status]
}

/**
 * The worst of several statuses (`ok` for none). `skipped` counts as `ok`: a check that does not
 * apply must never turn a healthy app red.
 *
 * @example
 * worstStatus(['ok', 'warning', 'skipped']) // 'warning'
 */
export function worstStatus(statuses: Iterable<HealthStatus>): 'ok' | 'warning' | 'failed' {
  let worst: 'ok' | 'warning' | 'failed' = 'ok'
  for (const status of statuses) {
    if (status === 'failed') return 'failed'
    if (status === 'warning') worst = 'warning'
  }
  return worst
}

/**
 * `true` for a value that is a known status (stored rows and config are checked with it).
 *
 * @example
 * isHealthStatus('ok') // true
 */
export function isHealthStatus(value: unknown): value is HealthStatus {
  return typeof value === 'string' && (HEALTH_STATUSES as readonly string[]).includes(value)
}

/**
 * Two limits on a measured value where higher is worse (latency, percent used, age).
 *
 * @example
 * const limits: Thresholds = { warnAt: 100, failAt: 1000 }
 */
export interface Thresholds {
  /** At or above this value the result is a warning. */
  readonly warnAt: number
  /** At or above this value the result is a failure. */
  readonly failAt: number
}

/**
 * The status a measured value earns against its thresholds.
 *
 * @example
 * thresholdStatus(250, { warnAt: 100, failAt: 1000 }) // 'warning'
 */
export function thresholdStatus(value: number, limits: Thresholds): 'ok' | 'warning' | 'failed' {
  if (!Number.isFinite(value) || value >= limits.failAt) return 'failed'
  if (value >= limits.warnAt) return 'warning'
  return 'ok'
}

/**
 * Why a pair of thresholds is unusable, or `undefined` when it is fine. Checks call it when they
 * are created, so a typo (warn above fail) stops the boot instead of hiding a problem.
 *
 * @example
 * thresholdProblem({ warnAt: 90, failAt: 70 }) // 'warnAt (90) must not be above failAt (70)'
 */
export function thresholdProblem(limits: Thresholds): string | undefined {
  if (!Number.isFinite(limits.warnAt) || limits.warnAt < 0)
    return `warnAt must be a finite number of at least 0 (got ${String(limits.warnAt)})`
  if (!Number.isFinite(limits.failAt) || limits.failAt < 0)
    return `failAt must be a finite number of at least 0 (got ${String(limits.failAt)})`
  if (limits.warnAt > limits.failAt)
    return `warnAt (${limits.warnAt}) must not be above failAt (${limits.failAt})`
  return undefined
}
