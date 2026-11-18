/**
 * Heartbeat checks: is a background process (the scheduler, a queue worker) still alive?
 *
 * A background process can't be probed from a web request; it can only prove it is alive by
 * leaving a trace. So the process calls {@link recordHeartbeat} on every tick or job, which
 * writes the time into the cache, and the check reports how old the last heartbeat is:
 *
 * ```ts
 * // in the scheduler loop or a queue worker (when the framework ships them, they call this)
 * await recordHeartbeat(cache.store(), 'scheduler', Date.now())
 *
 * // in config/health.ts or a provider
 * heartbeatCheck({ heartbeat: 'scheduler', warnAfterSeconds: 120, failAfterSeconds: 600 })
 * ```
 *
 * The framework's scheduler and queue are not released yet; this is the interface they will use,
 * and an app can already call it from its own workers.
 *
 * @module
 */
import { CacheManagerToken, type CacheStore } from '@strutvane/framework'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result, thresholdProblem, thresholdStatus } from '../result.ts'
import { invalidOption } from './options.ts'

/** Cache key prefix of heartbeats. */
export const HEARTBEAT_PREFIX = 'health:heartbeat:'

const HEARTBEAT_NAME = /^[a-z][a-z0-9]*(?:[-:.][a-z0-9]+)*$/

/**
 * Record that a background process is alive. The heartbeat lives a day in the cache, so a
 * process that stopped long ago is reported as "no heartbeat", not as a stale value forever.
 *
 * @example
 * await recordHeartbeat(app.make(CacheManagerToken).store(), 'queue:default', Date.now())
 */
export async function recordHeartbeat(store: CacheStore, name: string, now: number): Promise<void> {
  if (!HEARTBEAT_NAME.test(name))
    throw new TypeError(
      `Heartbeat name "${name}" must be lowercase, like "scheduler" or "queue:default".`,
    )
  await store.put(`${HEARTBEAT_PREFIX}${name}`, now, 86_400)
}

/**
 * Options of {@link heartbeatCheck}.
 *
 * @example
 * const options: HeartbeatCheckOptions = { heartbeat: 'scheduler' }
 */
export interface HeartbeatCheckOptions {
  /** Default: the heartbeat name with `:` and `.` turned into `-` (`queue:default` → `queue-default`). */
  readonly name?: string
  readonly label?: string
  /** The name the process records (`scheduler`, `queue:default`). */
  readonly heartbeat: string
  /** Age (seconds) at which the result becomes a warning. Default 120. */
  readonly warnAfterSeconds?: number
  /** Age (seconds) at which the result becomes a failure. Default 600. */
  readonly failAfterSeconds?: number
  /** The cache store heartbeats are written to. Default: the default store. */
  readonly store?: string
}

/**
 * Report the age of a background process's last heartbeat.
 *
 * @example
 * heartbeatCheck({ heartbeat: 'scheduler', failAfterSeconds: 300 })
 */
export function heartbeatCheck(options: HeartbeatCheckOptions): HealthCheck {
  if (!HEARTBEAT_NAME.test(options.heartbeat))
    throw invalidOption(
      'heartbeatCheck',
      `heartbeat "${options.heartbeat}" must be lowercase, like "scheduler"`,
    )
  const limits = {
    warnAt: options.warnAfterSeconds ?? 120,
    failAt: options.failAfterSeconds ?? 600,
  }
  const problem = thresholdProblem(limits)
  if (problem !== undefined) throw invalidOption('heartbeatCheck', problem)
  return defineCheck({
    name: options.name ?? options.heartbeat.replace(/[:.]/g, '-'),
    label: options.label ?? `Heartbeat: ${options.heartbeat}`,
    async run({ make, has, now }): Promise<CheckResult> {
      if (!has(CacheManagerToken))
        return Result.failed(
          'no cache',
          'Heartbeats are kept in the cache, and no cache manager is bound.',
        )
      const value = await make(CacheManagerToken)
        .store(options.store)
        .get(`${HEARTBEAT_PREFIX}${options.heartbeat}`)
      if (typeof value !== 'number' || !Number.isFinite(value))
        return Result.failed(
          'no heartbeat',
          `"${options.heartbeat}" has not reported in. Start it, and make it call recordHeartbeat() on every tick.`,
        )
      const ageSeconds = Math.max(0, Math.round((now() - value) / 1000))
      const meta = { ageSeconds }
      const summary = `${ageSeconds} s ago`
      const status = thresholdStatus(ageSeconds, limits)
      if (status === 'ok') return Result.ok(summary, meta)
      const message = `The last heartbeat of "${options.heartbeat}" is ${ageSeconds} s old. The process may have stopped or be stuck.`
      return status === 'warning'
        ? Result.warning(summary, message, meta)
        : Result.failed(summary, message, meta)
    },
  })
}
