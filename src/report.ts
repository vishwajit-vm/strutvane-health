/**
 * A health report: every check's result from one run, plus the overall status.
 *
 * @module
 */
import type { HealthStatus, ResultMeta } from './result.ts'
import { worstStatus } from './result.ts'

/**
 * One check's result inside a report (already sanitized: see `sanitize.ts`).
 *
 * @example
 * const run: CheckRun = { name: 'database', label: 'Database', status: 'ok', summary: '3 ms', meta: {}, durationMs: 3 }
 */
export interface CheckRun {
  readonly name: string
  readonly label: string
  readonly status: HealthStatus
  readonly summary: string
  readonly message?: string
  readonly meta: ResultMeta
  /** How long the check took (milliseconds, from the app's clock). */
  readonly durationMs: number
}

/**
 * The result of one run of the checks.
 *
 * @example
 * report.status // 'warning'
 * report.checks.find((run) => run.name === 'disk-space')?.summary // '78% used'
 */
export interface HealthReport {
  /** Identifies the run; every history row of the run carries it. */
  readonly id: string
  /** The worst status of all checks (`skipped` counts as `ok`). */
  readonly status: 'ok' | 'warning' | 'failed'
  /** When the run finished, ISO 8601 in UTC. */
  readonly finishedAt: string
  readonly checks: readonly CheckRun[]
}

/**
 * Build a report from its runs; the overall status is derived, never passed in, so it can't
 * disagree with the checks.
 *
 * @example
 * createReport('run-1', Date.now(), [databaseRun])
 */
export function createReport(
  id: string,
  finishedAtMs: number,
  checks: readonly CheckRun[],
): HealthReport {
  return {
    id,
    status: worstStatus(checks.map((run) => run.status)),
    finishedAt: new Date(finishedAtMs).toISOString(),
    checks,
  }
}

/**
 * The public view of a report: what the JSON endpoint serves. Messages are included only when
 * asked for; meta never is (it is for history and the CLI).
 *
 * @example
 * publicReport(report, { messages: false })
 * // { status: 'ok', finishedAt: '…', checks: [{ name: 'database', label: 'Database', status: 'ok', summary: '3 ms', durationMs: 3 }] }
 */
export function publicReport(
  report: HealthReport,
  options: { readonly messages: boolean },
): Readonly<Record<string, unknown>> {
  return {
    status: report.status,
    finishedAt: report.finishedAt,
    checks: report.checks.map((run) => ({
      name: run.name,
      label: run.label,
      status: run.status,
      summary: run.summary,
      durationMs: run.durationMs,
      ...(options.messages && run.message !== undefined ? { message: run.message } : {}),
    })),
  }
}
