/**
 * `database`: can the app reach its database, and how fast does it answer?
 *
 * Runs `SELECT 1` on the app's default connection (the one models use) and times it. Latency at
 * or above `warnMs` is a warning, at or above `failMs` (or any error) a failure. The query touches
 * no table, so it works before the first migration and never locks anything.
 *
 * @module
 */
import { DatabaseConnectionToken } from '@strutvane/framework'
import type { Token } from '@strutvane/framework/core'
import { type Connection, sql } from '@strutvane/framework/database'
import { defineCheck, type HealthCheck } from '../check.ts'
import { type CheckResult, Result, thresholdProblem, thresholdStatus } from '../result.ts'
import { errorText, invalidOption } from './options.ts'

/**
 * Options of {@link databaseCheck}.
 *
 * @example
 * const options: DatabaseCheckOptions = { warnMs: 50, failMs: 500 }
 */
export interface DatabaseCheckOptions {
  /** Default `database`; give a second instance another name. */
  readonly name?: string
  readonly label?: string
  /** The connection to probe. Default: the app's default connection. */
  readonly connection?: Token<Connection>
  /** Latency (ms) at which the result becomes a warning. Default 100. */
  readonly warnMs?: number
  /** Latency (ms) at which the result becomes a failure. Default 1000. */
  readonly failMs?: number
}

/**
 * Probe the database with `SELECT 1`.
 *
 * @example
 * databaseCheck({ warnMs: 50, failMs: 500 })
 */
export function databaseCheck(options: DatabaseCheckOptions = {}): HealthCheck {
  const limits = { warnAt: options.warnMs ?? 100, failAt: options.failMs ?? 1_000 }
  const problem = thresholdProblem(limits)
  if (problem !== undefined) throw invalidOption('databaseCheck', problem)
  const token = options.connection ?? DatabaseConnectionToken
  return defineCheck({
    name: options.name ?? 'database',
    label: options.label ?? 'Database',
    async run({ make, has, now }): Promise<CheckResult> {
      if (!has(token))
        return Result.failed(
          'not configured',
          'No database connection is bound. Boot the app (or bind one) before running health checks.',
        )
      const connection = make(token)
      const dialect = connection.grammar.dialect
      const started = now()
      try {
        await connection.run(sql`SELECT 1`)
      } catch (error) {
        return Result.failed(
          'unreachable',
          `${errorText(error)}. Check DB_* in .env and that the database server is running.`,
          { dialect },
        )
      }
      const latencyMs = Math.max(0, Math.round(now() - started))
      const status = thresholdStatus(latencyMs, limits)
      const meta = { latencyMs, dialect }
      const summary = `${latencyMs} ms`
      if (status === 'ok') return Result.ok(summary, meta)
      const limit = status === 'warning' ? limits.warnAt : limits.failAt
      const message = `SELECT 1 took ${latencyMs} ms (limit ${limit} ms). The database server, or the network to it, is overloaded.`
      return status === 'warning'
        ? Result.warning(summary, message, meta)
        : Result.failed(summary, message, meta)
    },
  })
}
