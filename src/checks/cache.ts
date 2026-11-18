/**
 * `cache`: can the app write to its cache and read the value back?
 *
 * Writes a random probe value under a random `health:probe:*` key (60-second TTL, so a crash
 * mid-check leaves nothing behind for long), reads it back, then deletes it. A store that accepts
 * writes but returns something else (a full disk under the file store, a misconfigured Redis
 * prefix) fails here before it breaks sessions or rate limits.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { CacheManagerToken } from '@strutvane/framework'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result, thresholdProblem, thresholdStatus } from '../result.ts'
import { errorText, invalidOption } from './options.ts'

/**
 * Options of {@link cacheCheck}.
 *
 * @example
 * const options: CacheCheckOptions = { store: 'file' }
 */
export interface CacheCheckOptions {
  readonly name?: string
  readonly label?: string
  /** The store to probe. Default: the app's default store. */
  readonly store?: string
  /** Round-trip time (ms) at which the result becomes a warning. Default 250. */
  readonly warnMs?: number
  /** Round-trip time (ms) at which the result becomes a failure. Default 2000. */
  readonly failMs?: number
}

/** The key prefix probes use; documented so operators recognise them in a store listing. */
export const CACHE_PROBE_PREFIX = 'health:probe:'

/**
 * Probe a cache store with a write, a read and a delete.
 *
 * @example
 * cacheCheck({ store: 'file' })
 */
export function cacheCheck(options: CacheCheckOptions = {}): HealthCheck {
  const limits = { warnAt: options.warnMs ?? 250, failAt: options.failMs ?? 2_000 }
  const problem = thresholdProblem(limits)
  if (problem !== undefined) throw invalidOption('cacheCheck', problem)
  return defineCheck({
    name: options.name ?? 'cache',
    label: options.label ?? 'Cache',
    async run({ make, has, now }): Promise<CheckResult> {
      if (!has(CacheManagerToken)) return Result.skipped('no cache manager')
      const manager = make(CacheManagerToken)
      const storeName = options.store ?? manager.defaultStore
      if (!manager.storeNames.includes(storeName))
        return Result.failed(
          'unknown store',
          `There is no cache store "${storeName}". Configured stores: ${manager.storeNames.join(', ') || 'none'}.`,
        )
      const store = manager.store(storeName)
      const key = `${CACHE_PROBE_PREFIX}${randomBytes(8).toString('hex')}`
      const value = randomBytes(8).toString('hex')
      const started = now()
      try {
        await store.put(key, value, 60)
        const read = await store.get(key)
        if (read !== value)
          return Result.failed(
            'read mismatch',
            `The "${storeName}" store accepted a write but returned a different value. Check its driver settings and free space.`,
            { store: storeName },
          )
      } catch (error) {
        return Result.failed(
          'unavailable',
          `The "${storeName}" store failed: ${errorText(error)}`,
          { store: storeName },
        )
      } finally {
        await store.forget(key).catch(() => false)
      }
      const latencyMs = Math.max(0, Math.round(now() - started))
      const meta = { store: storeName, latencyMs }
      const status = thresholdStatus(latencyMs, limits)
      const summary = `${storeName}, ${latencyMs} ms`
      if (status === 'ok') return Result.ok(summary, meta)
      const message = `A write and read on the "${storeName}" store took ${latencyMs} ms.`
      return status === 'warning'
        ? Result.warning(summary, message, meta)
        : Result.failed(summary, message, meta)
    },
  })
}
