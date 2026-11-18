/**
 * `debug-mode`: is `APP_DEBUG` off where it must be?
 *
 * The framework already refuses to show stack traces outside `local` and `testing`, and refuses
 * to boot with `APP_DEBUG=true` in production unless forced (`--force-debug`). A forced boot is
 * exactly when this check earns its keep: it keeps reporting `failed` until someone turns debug
 * off, instead of the setting being forgotten after the incident.
 *
 * @module
 */
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result } from '../result.ts'

/**
 * Options of {@link debugModeCheck}.
 *
 * @example
 * const options: DebugModeCheckOptions = { failIn: ['production'], warnIn: ['staging'] }
 */
export interface DebugModeCheckOptions {
  readonly name?: string
  readonly label?: string
  /** Environments where debug on is a failure. Default `['production']`. */
  readonly failIn?: readonly string[]
  /** Environments where debug on is a warning. Default `['staging']`. */
  readonly warnIn?: readonly string[]
}

/**
 * Fail when `app.debug` is on in production (warn in staging).
 *
 * @example
 * debugModeCheck()
 */
export function debugModeCheck(options: DebugModeCheckOptions = {}): HealthCheck {
  const failIn = options.failIn ?? ['production']
  const warnIn = options.warnIn ?? ['staging']
  return defineCheck({
    name: options.name ?? 'debug-mode',
    label: options.label ?? 'Debug mode',
    run({ config, environment }): CheckResult {
      const debug = config('app.debug') === true
      const meta = { debug, environment }
      if (!debug) return Result.ok('off', meta)
      const message = `APP_DEBUG is true in ${environment}. Set APP_DEBUG=false: debug mode is for local development only.`
      if (failIn.includes(environment)) return Result.failed(`on in ${environment}`, message, meta)
      if (warnIn.includes(environment)) return Result.warning(`on in ${environment}`, message, meta)
      return Result.ok(`on (${environment})`, meta)
    },
  })
}
