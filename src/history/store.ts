/**
 * Results history: where reports are kept, so you can see when a check started failing.
 *
 * Two stores implement {@link ResultStore}:
 * - {@link DatabaseResultStore}: the `health_check_results` table that `node strut add health`
 *   creates with a migration. One row per check per run; rows of one run share a `batch` id.
 * - {@link MemoryResultStore}: per process, for tests and apps without a database.
 *
 * **Why raw SQL and not a model:** the table belongs to this package, not to the app's models,
 * and must work before `.strutvane/schema.json` knows about it. Every statement is built with the
 * framework's `sql` tag (bound values, quoted identifiers), so nothing is ever concatenated.
 *
 * **Times are epoch milliseconds** (`ran_at`, a big integer): identical on SQLite, PostgreSQL and
 * MySQL, with no time-zone conversions to get wrong.
 *
 * @module
 */
import type { Connection } from '@strutvane/framework/database'
import { sql } from '@strutvane/framework/database'
import type { CheckRun, HealthReport } from '../report.ts'
import { createReport } from '../report.ts'
import { isHealthStatus, type MetaValue, type ResultMeta } from '../result.ts'

/** The history table the shipped migration creates. */
export const RESULTS_TABLE = 'health_check_results'

/** How many rows `history()` returns at most. */
export const MAX_HISTORY_ROWS = 1_000

/**
 * One stored check result.
 *
 * @example
 * const row: StoredRun = { ...run, batch: 'f1c…', ranAt: '2026-11-18T10:00:00.000Z' }
 */
export interface StoredRun extends CheckRun {
  readonly batch: string
  readonly ranAt: string
}

/**
 * Where reports are kept.
 *
 * @example
 * await store.save(report)
 * const last = await store.latest()
 */
export interface ResultStore {
  /** Keep a report (one row per check). */
  save(report: HealthReport): Promise<void>
  /** The most recent report, or `undefined` when nothing was stored yet. */
  latest(): Promise<HealthReport | undefined>
  /** Recent results, newest first; optionally of one check. `limit` is capped at 1000. */
  history(options?: { readonly check?: string; readonly limit?: number }): Promise<StoredRun[]>
  /** Delete results older than `beforeMs` (epoch ms); returns how many rows went. */
  prune(beforeMs: number): Promise<number>
}

/**
 * Keeps reports in memory (newest last), bounded so a long-running process can't grow it forever.
 *
 * @example
 * const store = new MemoryResultStore({ maxReports: 100 })
 */
export class MemoryResultStore implements ResultStore {
  readonly #reports: HealthReport[] = []
  readonly #max: number

  constructor(options: { readonly maxReports?: number } = {}) {
    this.#max = options.maxReports ?? 500
  }

  /** @inheritDoc */
  async save(report: HealthReport): Promise<void> {
    this.#reports.push(report)
    if (this.#reports.length > this.#max) this.#reports.splice(0, this.#reports.length - this.#max)
  }

  /** @inheritDoc */
  async latest(): Promise<HealthReport | undefined> {
    return this.#reports.at(-1)
  }

  /** @inheritDoc */
  async history(
    options: { readonly check?: string; readonly limit?: number } = {},
  ): Promise<StoredRun[]> {
    const limit = clampLimit(options.limit)
    const out: StoredRun[] = []
    for (const report of [...this.#reports].reverse()) {
      for (const run of report.checks) {
        if (options.check !== undefined && run.name !== options.check) continue
        out.push({ ...run, batch: report.id, ranAt: report.finishedAt })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /** @inheritDoc */
  async prune(beforeMs: number): Promise<number> {
    let removed = 0
    for (let i = this.#reports.length - 1; i >= 0; i -= 1) {
      const report = this.#reports[i]
      if (report !== undefined && Date.parse(report.finishedAt) < beforeMs) {
        removed += report.checks.length
        this.#reports.splice(i, 1)
      }
    }
    return removed
  }
}

/**
 * Keeps reports in the `health_check_results` table.
 *
 * @example
 * const store = new DatabaseResultStore(() => app.make(DatabaseConnectionToken))
 */
export class DatabaseResultStore implements ResultStore {
  readonly #connection: () => Connection
  readonly #table: string

  /**
   * @param connection - resolved on each call, so the store can be built before the connection
   *   opens (the app opens it lazily on the first query).
   * @param options.table - another table name (it must exist, with the shipped migration's columns).
   */
  constructor(connection: () => Connection, options: { readonly table?: string } = {}) {
    this.#connection = connection
    this.#table = options.table ?? RESULTS_TABLE
  }

  /** @inheritDoc */
  async save(report: HealthReport): Promise<void> {
    const ranAt = Date.parse(report.finishedAt)
    const connection = this.#connection()
    // One transaction: a report is stored whole or not at all, so `latest()` never sees half a run.
    await connection.transaction(async () => {
      for (const run of report.checks) {
        await connection.run(sql`INSERT INTO ${sql.id(this.#table)} (
          ${sql.id('batch')}, ${sql.id('check_name')}, ${sql.id('check_label')}, ${sql.id('status')},
          ${sql.id('summary')}, ${sql.id('message')}, ${sql.id('meta')}, ${sql.id('duration_ms')}, ${sql.id('ran_at')}
        ) VALUES (
          ${report.id}, ${run.name}, ${run.label}, ${run.status}, ${run.summary},
          ${run.message ?? null}, ${JSON.stringify(run.meta)}, ${run.durationMs}, ${ranAt}
        )`)
      }
    })
  }

  /** @inheritDoc */
  async latest(): Promise<HealthReport | undefined> {
    const connection = this.#connection()
    const last = await connection.run(
      sql`SELECT ${sql.id('batch')} FROM ${sql.id(this.#table)} ORDER BY ${sql.id('ran_at')} DESC, ${sql.id('id')} DESC LIMIT 1`,
    )
    const batch = last.rows[0]?.['batch']
    if (typeof batch !== 'string') return undefined
    const rows = await connection.run(
      sql`SELECT * FROM ${sql.id(this.#table)} WHERE ${sql.id('batch')} = ${batch} ORDER BY ${sql.id('id')} ASC`,
    )
    const runs = rows.rows.map(toStoredRun).filter((run): run is StoredRun => run !== undefined)
    const first = runs[0]
    if (first === undefined) return undefined
    return createReport(batch, Date.parse(first.ranAt), runs.map(withoutStorage))
  }

  /** @inheritDoc */
  async history(
    options: { readonly check?: string; readonly limit?: number } = {},
  ): Promise<StoredRun[]> {
    const limit = clampLimit(options.limit)
    const table = sql.id(this.#table)
    const order = sql`ORDER BY ${sql.id('ran_at')} DESC, ${sql.id('id')} DESC LIMIT ${limit}`
    const query =
      options.check === undefined
        ? sql`SELECT * FROM ${table} ${order}`
        : sql`SELECT * FROM ${table} WHERE ${sql.id('check_name')} = ${options.check} ${order}`
    const result = await this.#connection().run(query)
    return result.rows.map(toStoredRun).filter((run): run is StoredRun => run !== undefined)
  }

  /** @inheritDoc */
  async prune(beforeMs: number): Promise<number> {
    const result = await this.#connection().run(
      sql`DELETE FROM ${sql.id(this.#table)} WHERE ${sql.id('ran_at')} < ${Math.floor(beforeMs)}`,
    )
    return result.rowsAffected
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100
  return Math.min(MAX_HISTORY_ROWS, Math.max(1, Math.floor(limit)))
}

function withoutStorage(run: StoredRun): CheckRun {
  const { batch: _batch, ranAt: _ranAt, ...rest } = run
  return rest
}

/** A row → a stored run; `undefined` for a row that is not one (it is skipped, not trusted). */
function toStoredRun(row: Readonly<Record<string, unknown>>): StoredRun | undefined {
  const status = row['status']
  const name = row['check_name']
  const batch = row['batch']
  const ranAt = Number(row['ran_at'])
  if (!isHealthStatus(status) || typeof name !== 'string' || typeof batch !== 'string')
    return undefined
  if (!Number.isFinite(ranAt)) return undefined
  const message = row['message']
  return {
    batch,
    name,
    label: typeof row['check_label'] === 'string' ? row['check_label'] : name,
    status,
    summary: typeof row['summary'] === 'string' ? row['summary'] : status,
    ...(typeof message === 'string' ? { message } : {}),
    meta: parseMeta(row['meta']),
    durationMs: Number(row['duration_ms']) || 0,
    ranAt: new Date(ranAt).toISOString(),
  }
}

function parseMeta(value: unknown): ResultMeta {
  if (typeof value !== 'string') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, MetaValue> = {}
  for (const [key, entry] of Object.entries(parsed)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry))
      out[key] = entry as MetaValue
  }
  return out
}
