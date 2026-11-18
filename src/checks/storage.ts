/**
 * `storage`: can the app write where it needs to?
 *
 * Two probes, because "storage" means two things in an app:
 * - **Folders** (`storage/framework`, `storage/logs` by default): the file cache, sessions and log
 *   files live there. A read-only mount or wrong ownership after a deploy breaks sign-in and
 *   silences logs, so the check writes a small probe file, reads it back and removes it.
 * - **A storage disk** (optional, `disk: 'local'`): uploads go through the framework's
 *   `StorageManager`. The check puts, reads and deletes a probe object under `.health/`.
 *
 * Probe names are random, created with `wx` (never following or overwriting an existing file)
 * and always removed, also when the check fails half-way.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StorageManagerToken } from '@strutvane/framework'
import type { StorageDisk } from '@strutvane/framework/contracts'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result } from '../result.ts'
import { errorText, invalidOption, isContainedPath } from './options.ts'

/**
 * Options of {@link storageCheck}.
 *
 * @example
 * const options: StorageCheckOptions = { paths: ['storage/framework', 'storage/logs'], disk: 'local' }
 */
export interface StorageCheckOptions {
  readonly name?: string
  readonly label?: string
  /** Folders that must be writable, relative to the app root. */
  readonly paths?: readonly string[]
  /** A storage disk to probe as well (needs a `StorageManager` in the container). */
  readonly disk?: string
}

/** The folders checked by default. */
export const DEFAULT_WRITABLE_PATHS: readonly string[] = Object.freeze([
  'storage/framework',
  'storage/logs',
])

/**
 * Check that folders (and optionally a storage disk) are writable.
 *
 * @example
 * storageCheck({ disk: 'local' })
 */
export function storageCheck(options: StorageCheckOptions = {}): HealthCheck {
  const paths = options.paths ?? DEFAULT_WRITABLE_PATHS
  for (const path of paths)
    if (!isContainedPath(path))
      throw invalidOption('storageCheck', `path "${path}" must be a path inside the app`)
  return defineCheck({
    name: options.name ?? 'storage',
    label: options.label ?? 'Storage',
    async run({ basePath, make, has }): Promise<CheckResult> {
      const problems: string[] = []
      for (const path of paths) {
        const problem = await probeFolder(join(basePath, path))
        if (problem !== undefined) problems.push(`${path}: ${problem}`)
      }
      if (options.disk !== undefined) {
        if (!has(StorageManagerToken))
          problems.push(`disk "${options.disk}": no storage manager is bound`)
        else {
          const problem = await probeStorageDisk(() => make(StorageManagerToken).disk(options.disk))
          if (problem !== undefined) problems.push(`disk "${options.disk}": ${problem}`)
        }
      }
      const checked = paths.length + (options.disk === undefined ? 0 : 1)
      if (problems.length > 0)
        return Result.failed(
          `${problems.length} of ${checked} not writable`,
          `${problems.join('; ')}. Check that the folders exist and belong to the user the app runs as.`,
          { checked, failing: problems.length },
        )
      return Result.ok(`${checked} writable`, { checked })
    },
  })
}

async function probeFolder(folder: string): Promise<string | undefined> {
  const file = join(folder, `.health-probe-${randomBytes(8).toString('hex')}`)
  const content = randomBytes(8).toString('hex')
  try {
    await writeFile(file, content, { flag: 'wx', mode: 0o600 })
    const read = await readFile(file, 'utf8')
    return read === content ? undefined : 'read back a different value'
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
    return typeof code === 'string' ? code : errorText(error)
  } finally {
    await rm(file, { force: true }).catch(() => undefined)
  }
}

async function probeStorageDisk(disk: () => StorageDisk): Promise<string | undefined> {
  let target: StorageDisk
  try {
    target = disk()
  } catch (error) {
    return errorText(error)
  }
  const key = `.health/probe-${randomBytes(8).toString('hex')}.txt`
  const content = randomBytes(8).toString('hex')
  try {
    await target.put(key, content)
    const read = await new Response(await target.get(key)).text()
    return read === content ? undefined : 'read back a different value'
  } catch (error) {
    return errorText(error)
  } finally {
    await target.delete(key).catch(() => undefined)
  }
}
