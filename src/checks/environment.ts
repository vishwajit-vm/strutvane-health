/**
 * `environment`: does the running environment define every variable `.env.example` lists?
 *
 * `.env.example` is the app's own list of settings (every package's installer adds its keys
 * there). A key that is missing in production usually means a deploy forgot a new setting, and
 * the feature behind it will fail at the worst moment. The check reports missing **names** only:
 * values are never read into the result, so it can't leak a secret.
 *
 * - Missing keys are a failure. A key present with an empty value counts as present (many
 *   settings are optional), unless it is listed in `required`.
 * - Keys listed in `ignore` are not checked (for example `DB_PASSWORD` on a socket connection).
 * - No `.env.example` means the check does not apply (`skipped`).
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result } from '../result.ts'
import { invalidOption, isContainedPath } from './options.ts'

/**
 * Options of {@link environmentCheck}.
 *
 * @example
 * const options: EnvironmentCheckOptions = { ignore: ['MAIL_PASSWORD'], required: ['APP_URL'] }
 */
export interface EnvironmentCheckOptions {
  readonly name?: string
  readonly label?: string
  /** The example file, relative to the app root. Default `.env.example`. */
  readonly example?: string
  /** Keys that are not checked. */
  readonly ignore?: readonly string[]
  /** Keys that must also be non-empty. */
  readonly required?: readonly string[]
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

/** How many missing names a message lists before it says "and N more". */
const LISTED = 10

/**
 * The variable names a dotenv file declares, in order, without duplicates.
 *
 * @example
 * envKeys('APP_NAME=Blog\n# comment\nexport DB_HOST=localhost') // ['APP_NAME', 'DB_HOST']
 */
export function envKeys(source: string): string[] {
  const keys = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line)
    if (match?.[1] !== undefined) keys.add(match[1])
  }
  return [...keys]
}

/**
 * Compare the environment with `.env.example`.
 *
 * @example
 * environmentCheck({ ignore: ['DB_PASSWORD'] })
 */
export function environmentCheck(options: EnvironmentCheckOptions = {}): HealthCheck {
  const example = options.example ?? '.env.example'
  if (!isContainedPath(example))
    throw invalidOption('environmentCheck', `example "${example}" must be a path inside the app`)
  const ignore = new Set(options.ignore ?? [])
  const required = options.required ?? []
  return defineCheck({
    name: options.name ?? 'environment',
    label: options.label ?? 'Environment',
    run({ basePath, env }): CheckResult {
      const file = join(basePath, example)
      if (!existsSync(file)) return Result.skipped(`no ${example}`)
      const keys = [...new Set([...envKeys(readFileSync(file, 'utf8')), ...required])].filter(
        (key) => !ignore.has(key),
      )
      const missing = keys.filter((key) => env[key] === undefined)
      const empty = required.filter(
        (key) => !ignore.has(key) && env[key] !== undefined && env[key]?.trim() === '',
      )
      const meta = { keys: keys.length, missing: missing.length, empty: empty.length }
      if (missing.length === 0 && empty.length === 0) return Result.ok(`${keys.length} set`, meta)
      const parts: string[] = []
      if (missing.length > 0) parts.push(`missing: ${listed(missing)}`)
      if (empty.length > 0) parts.push(`empty but required: ${listed(empty)}`)
      return Result.failed(
        `${missing.length + empty.length} not set`,
        `${parts.join('; ')}. Set them in the server's environment (or .env); ${example} lists every setting.`,
        meta,
      )
    },
  })
}

function listed(keys: readonly string[]): string {
  const shown = keys.slice(0, LISTED).join(', ')
  return keys.length > LISTED ? `${shown} and ${keys.length - LISTED} more` : shown
}
