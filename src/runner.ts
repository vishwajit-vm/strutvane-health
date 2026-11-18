/**
 * Running checks safely: each one gets a deadline, its errors become `failed` results, and its
 * output is sanitized.
 *
 * Failure scenarios handled here, so no check has to:
 * - **A check hangs** (a database that accepts the connection and never answers): the runner stops
 *   waiting at the deadline, reports `failed: timed out after N ms` and aborts the check's
 *   `signal`. The other checks are unaffected; they run concurrently.
 * - **A check throws** (or rejects): reported as `failed` with the error's message (and `code`,
 *   when it has one), sanitized. The stack is never included: it is noise in Slack and can carry
 *   file paths.
 * - **A check returns garbage** (no status, a status from a newer version): reported as `failed`
 *   with a message naming the check, so a broken custom check is visible, not silently green.
 *
 * @module
 */
import { type CheckContext, checkLabel, type HealthCheck } from './check.ts'
import type { CheckRun } from './report.ts'
import { type CheckResult, isHealthStatus, Result } from './result.ts'
import { sanitizeResult } from './sanitize.ts'

/** The default per-check deadline. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5_000

/**
 * How to run a batch of checks.
 *
 * @example
 * const options: RunCheckOptions = { context, timeoutMs: 5_000, secrets: [], now: Date.now }
 */
export interface RunCheckOptions {
  /** Builds a check's context around the signal the runner made for it. */
  readonly context: (signal: AbortSignal) => CheckContext
  /** Deadline for checks that don't set their own `timeoutMs`. */
  readonly timeoutMs: number
  /** Secret values to mask in the results (see `secretValues`). */
  readonly secrets: readonly string[]
  /** Milliseconds since the epoch (durations come from it, so tests are deterministic). */
  readonly now: () => number
}

/**
 * Run checks concurrently and return one sanitized {@link CheckRun} per check, in input order.
 * Never throws.
 *
 * @example
 * const runs = await runChecks([databaseCheck()], { context, timeoutMs: 5_000, secrets, now: Date.now })
 */
export async function runChecks(
  checks: readonly HealthCheck[],
  options: RunCheckOptions,
): Promise<CheckRun[]> {
  return Promise.all(checks.map((check) => runOne(check, options)))
}

async function runOne(check: HealthCheck, options: RunCheckOptions): Promise<CheckRun> {
  const started = options.now()
  const timeoutMs = check.timeoutMs ?? options.timeoutMs
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`health check "${check.name}" timed out`))
      resolve(
        Result.failed(
          `timed out after ${timeoutMs} ms`,
          `The check did not finish within ${timeoutMs} ms. A dependency is hanging or very slow; raise the check's timeoutMs only if that is expected.`,
          { timeoutMs },
        ),
      )
    }, timeoutMs)
    // A pending deadline must never keep the process alive (health:check exits when done).
    timer.unref()
  })
  let result: CheckResult
  try {
    result = await Promise.race([invoke(check, options.context(controller.signal)), deadline])
  } catch (error) {
    result = failureFrom(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const safe = sanitizeResult(validated(check, result), options.secrets)
  const durationMs = Math.max(0, Math.round(options.now() - started))
  return {
    name: check.name,
    label: checkLabel(check),
    status: safe.status,
    summary: safe.summary,
    ...(safe.message === undefined ? {} : { message: safe.message }),
    meta: safe.meta,
    durationMs,
  }
}

async function invoke(check: HealthCheck, context: CheckContext): Promise<CheckResult> {
  // `await` inside the try turns a synchronous throw into a rejection the caller catches.
  return await check.run(context)
}

/**
 * A `failed` result for a thrown value: its message and `code`, never its stack.
 *
 * @example
 * failureFrom(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
 * // { status: 'failed', summary: 'ECONNREFUSED', message: 'connect ECONNREFUSED', meta: {} }
 */
export function failureFrom(error: unknown): CheckResult {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
      ? String(Reflect.get(error, 'code'))
      : undefined
  return Result.failed(
    code ?? 'error',
    message.trim() === '' ? 'The check threw an error.' : message,
  )
}

function validated(check: HealthCheck, result: unknown): CheckResult {
  if (typeof result !== 'object' || result === null)
    return Result.failed('invalid result', `Check "${check.name}" returned no result.`)
  const value = result as Readonly<Record<string, unknown>>
  if (!isHealthStatus(value['status']))
    return Result.failed(
      'invalid result',
      `Check "${check.name}" returned an unknown status ${JSON.stringify(value['status'])}; use Result.ok/warning/failed/skipped.`,
    )
  const summary = typeof value['summary'] === 'string' ? value['summary'] : value['status']
  const meta = typeof value['meta'] === 'object' && value['meta'] !== null ? value['meta'] : {}
  const message = typeof value['message'] === 'string' ? value['message'] : undefined
  return {
    status: value['status'],
    summary,
    meta: meta as CheckResult['meta'],
    ...(message === undefined ? {} : { message }),
  }
}
