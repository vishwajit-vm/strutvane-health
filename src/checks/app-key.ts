/**
 * `app-key`: is `APP_KEY` set and strong enough?
 *
 * Every cookie, session, signed URL and encrypted column derives its key from `APP_KEY`, so an
 * app normally refuses to boot without one. This check still matters: it also runs from
 * `node strut health:check` in CI against a deploy's environment, and it validates
 * `APP_PREVIOUS_KEYS` (a malformed old key silently breaks decryption of old values).
 *
 * It uses the framework's own `keyProblem`, so the rules can never drift from the boot guard, and
 * like it, never echoes a key.
 *
 * @module
 */
import { keyProblem } from '@strutvane/framework'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result } from '../result.ts'

/**
 * Options of {@link appKeyCheck}.
 *
 * @example
 * const options: AppKeyCheckOptions = { label: 'Encryption key' }
 */
export interface AppKeyCheckOptions {
  readonly name?: string
  readonly label?: string
}

/**
 * Validate `APP_KEY` (config `app.key`, else the environment) and `APP_PREVIOUS_KEYS`.
 *
 * @example
 * appKeyCheck()
 */
export function appKeyCheck(options: AppKeyCheckOptions = {}): HealthCheck {
  return defineCheck({
    name: options.name ?? 'app-key',
    label: options.label ?? 'App key',
    run({ config, env }): CheckResult {
      const configured = config('app.key')
      const key = typeof configured === 'string' ? configured : env['APP_KEY']
      const problem = keyProblem(key)
      if (problem !== undefined)
        return Result.failed(
          `APP_KEY ${problem}`,
          `APP_KEY ${problem}. Run \`node strut key:generate\` and set the value in the environment (never in .env.example).`,
        )
      const previousConfig = config('app.previous_keys')
      const previous =
        typeof previousConfig === 'string' ? previousConfig : (env['APP_PREVIOUS_KEYS'] ?? '')
      const entries = previous
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      const bad = entries.findIndex((entry) => keyProblem(entry) !== undefined)
      if (bad !== -1)
        return Result.failed(
          `APP_PREVIOUS_KEYS entry ${bad + 1} is invalid`,
          `APP_PREVIOUS_KEYS entry ${bad + 1} ${String(keyProblem(entries[bad]))}. Fix or remove it; old cookies and encrypted values can't be read with it.`,
          { previousKeys: entries.length },
        )
      return Result.ok('set', { previousKeys: entries.length })
    },
  })
}
