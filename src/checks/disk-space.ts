/**
 * `disk-space`: how full is the disk the app writes to?
 *
 * Measures the file system that holds a folder of the app (default `storage`, where logs, the
 * file cache, sessions and uploads live) with `statfs`. It reports the share of the space that is
 * *not available to the app* (what `df` shows as Use%), because that is what runs out: a disk
 * whose reserved blocks are free is still full for the app.
 *
 * @module
 */
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result, thresholdProblem, thresholdStatus } from '../result.ts'
import { errorText, invalidOption, isContainedPath } from './options.ts'

/**
 * The `statfs` numbers the check needs (injectable for tests).
 *
 * @example
 * const stats: DiskStats = { blocks: 1000, bavail: 250, bsize: 4096 }
 */
export interface DiskStats {
  readonly blocks: number
  /** Blocks available to unprivileged users. */
  readonly bavail: number
  readonly bsize: number
}

/**
 * Options of {@link diskSpaceCheck}.
 *
 * @example
 * const options: DiskSpaceCheckOptions = { path: 'storage', warnPercent: 70, failPercent: 90 }
 */
export interface DiskSpaceCheckOptions {
  readonly name?: string
  readonly label?: string
  /** A folder on the disk to measure, relative to the app root. Default `storage`. */
  readonly path?: string
  /** Percent used at which the result becomes a warning. Default 70. */
  readonly warnPercent?: number
  /** Percent used at which the result becomes a failure. Default 90. */
  readonly failPercent?: number
  /** Replaces `fs.statfs` (tests). */
  readonly statfs?: (path: string) => Promise<DiskStats>
}

/**
 * Warn and fail when the disk under `path` fills up.
 *
 * @example
 * diskSpaceCheck({ warnPercent: 80, failPercent: 95 })
 */
export function diskSpaceCheck(options: DiskSpaceCheckOptions = {}): HealthCheck {
  const path = options.path ?? 'storage'
  if (!isContainedPath(path))
    throw invalidOption('diskSpaceCheck', `path "${path}" must be a path inside the app`)
  const limits = { warnAt: options.warnPercent ?? 70, failAt: options.failPercent ?? 90 }
  const problem = thresholdProblem(limits)
  if (problem !== undefined) throw invalidOption('diskSpaceCheck', problem)
  if (limits.failAt > 100) throw invalidOption('diskSpaceCheck', 'failPercent must be at most 100')
  const measure = options.statfs ?? ((target: string) => statfs(target))
  return defineCheck({
    name: options.name ?? 'disk-space',
    label: options.label ?? 'Disk space',
    async run({ basePath }): Promise<CheckResult> {
      let stats: DiskStats
      try {
        stats = await measure(join(basePath, path))
      } catch (error) {
        return Result.failed(
          'unreadable',
          `Can't measure the disk under ${path}: ${errorText(error)}. Create the folder or point disk_space.path at an existing one.`,
        )
      }
      if (!(stats.blocks > 0) || !(stats.bavail >= 0))
        return Result.failed('unreadable', `The file system under ${path} reported no size.`)
      const usedPercent = Math.round((1 - stats.bavail / stats.blocks) * 1000) / 10
      const freeMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024))
      const meta = { usedPercent, freeMb }
      const summary = `${usedPercent}% used, ${freeMb} MB free`
      const status = thresholdStatus(usedPercent, limits)
      if (status === 'ok') return Result.ok(summary, meta)
      const message = `The disk under ${path} is ${usedPercent}% full. Free space (old logs, caches, uploads) or grow the disk before writes start failing.`
      return status === 'warning'
        ? Result.warning(summary, message, meta)
        : Result.failed(summary, message, meta)
    },
  })
}
