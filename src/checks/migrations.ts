/**
 * `migrations`: has every migration in `database/migrations` run?
 *
 * Compares the migration files with the rows of the `migrations` table. A pending migration
 * means the code expects a schema the database does not have yet (the classic "deployed but
 * forgot `node strut migrate`"), so it is a failure. A migration that ran but whose file is gone
 * is a warning: the history and the code disagree.
 *
 * It compares names only. Checksums (a migration edited after it ran) are verified by
 * `node strut migrate:status`, which replays every file in a sandbox: too heavy for a check that
 * may run every minute.
 *
 * @module
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseConnectionToken } from '@strutvane/framework'
import type { Token } from '@strutvane/framework/core'
import { type Connection, MIGRATIONS_TABLE, sql } from '@strutvane/framework/database'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result } from '../result.ts'
import { invalidOption, isContainedPath } from './options.ts'

/** Laravel-named migration files (`2026_01_02_000000_create_posts_table.ts`). */
const MIGRATION_FILE = /^(\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+)\.(?:ts|mts|js|mjs)$/
/** Driver messages for "the table does not exist" (SQLite, Postgres, MySQL/MariaDB). */
const NO_TABLE = /no such table|does not exist|doesn't exist|\b42P01\b|\b1146\b|ER_NO_SUCH_TABLE/i

/**
 * Options of {@link migrationsCheck}.
 *
 * @example
 * const options: MigrationsCheckOptions = { directory: 'database/migrations' }
 */
export interface MigrationsCheckOptions {
  readonly name?: string
  readonly label?: string
  /** The migrations folder, relative to the app root. Default `database/migrations`. */
  readonly directory?: string
  readonly connection?: Token<Connection>
}

/**
 * Report pending (and vanished) migrations.
 *
 * @example
 * migrationsCheck()
 */
export function migrationsCheck(options: MigrationsCheckOptions = {}): HealthCheck {
  const directory = options.directory ?? 'database/migrations'
  if (!isContainedPath(directory))
    throw invalidOption('migrationsCheck', `directory "${directory}" must be a path inside the app`)
  const token = options.connection ?? DatabaseConnectionToken
  return defineCheck({
    name: options.name ?? 'migrations',
    label: options.label ?? 'Migrations',
    async run({ basePath, make, has }): Promise<CheckResult> {
      const folder = join(basePath, directory)
      if (!existsSync(folder)) return Result.skipped(`no ${directory} folder`)
      const files = migrationNames(readdirSync(folder))
      if (!has(token)) return Result.failed('not configured', 'No database connection is bound.')
      const ran = await ranMigrations(make(token))
      const pending = files.filter((name) => !ran.has(name))
      const missing = [...ran].filter((name) => !files.includes(name)).sort()
      const meta = {
        files: files.length,
        ran: ran.size,
        pending: pending.length,
        missing: missing.length,
      }
      if (pending.length > 0)
        return Result.failed(
          `${pending.length} pending`,
          `${pending.length} migration(s) have not run, starting with ${pending[0]}. Run \`node strut migrate\`.`,
          meta,
        )
      if (missing.length > 0)
        return Result.warning(
          `${missing.length} without a file`,
          `${missing.length} migration(s) ran but their files are gone, starting with ${missing[0]}. Restore the files; never delete a migration that ran.`,
          meta,
        )
      return Result.ok(`${files.length} ran`, meta)
    },
  })
}

/**
 * Migration names (without extension) from a folder listing, sorted and deduplicated.
 *
 * @example
 * migrationNames(['2026_01_01_000000_create_users_table.ts', 'README.md'])
 * // ['2026_01_01_000000_create_users_table']
 */
export function migrationNames(files: readonly string[]): string[] {
  const names = new Set<string>()
  for (const file of files) {
    const match = MIGRATION_FILE.exec(file)
    if (match?.[1] !== undefined) names.add(match[1])
  }
  return [...names].sort()
}

/** The names in the `migrations` table; empty when the table does not exist yet. */
async function ranMigrations(connection: Connection): Promise<Set<string>> {
  try {
    const result = await connection.run(
      sql`SELECT ${sql.id('migration')} FROM ${sql.id(MIGRATIONS_TABLE)}`,
    )
    const names = result.rows.map((row) => row['migration'])
    return new Set(names.filter((name): name is string => typeof name === 'string'))
  } catch (error) {
    const code = error instanceof Error ? String(Reflect.get(error, 'code')) : ''
    if (error instanceof Error && NO_TABLE.test(`${error.message} ${code}`)) return new Set()
    throw error
  }
}
