/**
 * Shared option validation for the built-in checks.
 *
 * @module
 */
import { BootError } from '@strutvane/framework'

/**
 * The error a built-in check factory throws for a bad option: a `BootError`, so it stops the boot
 * with the fix instead of producing a check that can never pass (or never fail).
 *
 * @example
 * throw invalidOption('diskSpaceCheck', 'warnPercent must be from 0 to 100')
 */
export function invalidOption(factory: string, problem: string): BootError {
  return new BootError(
    'invalid_health_check',
    `${factory}(): ${problem}.`,
    'Fix the option in config/health.ts or where the check is created.',
  )
}

/**
 * `true` for a relative path that stays inside the app folder (no `..` segments, not absolute).
 * Paths from config are resolved against the app root; refusing `..` keeps a typo or a hostile
 * config from probing files elsewhere on the server.
 *
 * @example
 * isContainedPath('storage/logs') // true
 * isContainedPath('../etc') // false
 */
export function isContainedPath(path: string): boolean {
  if (path.trim() === '' || path.includes('\0')) return false
  if (/^(?:[a-zA-Z]:)?[\\/]/.test(path)) return false
  return path.split(/[\\/]+/).every((segment) => segment !== '..')
}

/**
 * The text of a thrown value, for a check's message.
 *
 * @example
 * errorText(new Error('boom')) // 'boom'
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
