import { sql } from '@strutvane/framework/database'
import { describe, expect, it } from 'vitest'
import {
  DatabaseResultStore,
  MAX_HISTORY_ROWS,
  MemoryResultStore,
  RESULTS_TABLE,
} from '../../src/history/store.ts'
import { createReport, type HealthReport } from '../../src/report.ts'
import { migrateHealthTable, sqliteConnection } from '../helpers.ts'

const T0 = Date.UTC(2026, 10, 18, 10, 0, 0)

function report(id: string, at: number, overrides: Partial<HealthReport['checks'][number]> = {}) {
  return createReport(id, at, [
    {
      name: 'database',
      label: 'Database',
      status: 'ok',
      summary: '3 ms',
      meta: { latencyMs: 3 },
      durationMs: 3,
    },
    {
      name: 'disk-space',
      label: 'Disk space',
      status: 'warning',
      summary: '75% used',
      message: 'free space',
      meta: { usedPercent: 75 },
      durationMs: 1,
      ...overrides,
    },
  ])
}

describe('the shipped migration (real sandbox + runner on SQLite)', () => {
  it('creates the results table with its columns', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    const columns = await connection.run(sql`PRAGMA table_info(health_check_results)`)
    expect(columns.rows.map((row) => row['name'])).toEqual([
      'id',
      'batch',
      'check_name',
      'check_label',
      'status',
      'summary',
      'message',
      'meta',
      'duration_ms',
      'ran_at',
    ])
  })
})

describe('DatabaseResultStore', () => {
  it('saves a report and reads it back as the latest', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    const store = new DatabaseResultStore(() => connection)
    expect(await store.latest()).toBeUndefined()
    await store.save(report('run-1', T0))
    await store.save(report('run-2', T0 + 60_000, { status: 'failed', summary: '95% used' }))
    const latest = await store.latest()
    expect(latest?.id).toBe('run-2')
    expect(latest?.status).toBe('failed')
    expect(latest?.finishedAt).toBe(new Date(T0 + 60_000).toISOString())
    expect(latest?.checks.map((run) => run.name)).toEqual(['database', 'disk-space'])
    expect(latest?.checks[1]).toMatchObject({ message: 'free space', meta: { usedPercent: 75 } })
    expect(latest?.checks[0]).not.toHaveProperty('message')
  })

  it('lists history newest first, per check, and caps the limit', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    const store = new DatabaseResultStore(() => connection)
    for (let i = 0; i < 3; i += 1) await store.save(report(`run-${i}`, T0 + i * 1000))
    const all = await store.history()
    expect(all).toHaveLength(6)
    expect(all[0]?.batch).toBe('run-2')
    const disk = await store.history({ check: 'disk-space', limit: 2 })
    expect(disk.map((run) => run.batch)).toEqual(['run-2', 'run-1'])
    expect(disk[0]?.ranAt).toBe(new Date(T0 + 2000).toISOString())
    expect(await store.history({ limit: 0 })).toHaveLength(1)
    expect(await store.history({ limit: Number.NaN })).toHaveLength(6)
    expect(MAX_HISTORY_ROWS).toBe(1000)
  })

  it('treats a check name as data, never as SQL', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    const store = new DatabaseResultStore(() => connection)
    await store.save(report('run-1', T0))
    expect(await store.history({ check: "x' OR '1'='1" })).toEqual([])
    expect(await store.history()).toHaveLength(2)
  })

  it('prunes rows older than a cut-off', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    const store = new DatabaseResultStore(() => connection)
    await store.save(report('old', T0))
    await store.save(report('new', T0 + 10_000))
    expect(await store.prune(T0 + 5_000)).toBe(2)
    expect((await store.history()).map((run) => run.batch)).toEqual(['new', 'new'])
  })

  it('skips malformed rows and never trusts stored meta (prototype pollution)', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    const insert = (status: string, meta: string | null, batch = 'b') =>
      connection.run(sql`INSERT INTO ${sql.id(RESULTS_TABLE)}
        (batch, check_name, check_label, status, summary, message, meta, duration_ms, ran_at)
        VALUES (${batch}, ${'x'}, ${'X'}, ${status}, ${'s'}, ${null}, ${meta}, ${1}, ${T0})`)
    await insert('ok', '{"__proto__":{"polluted":true},"constructor":1,"nested":{"a":1},"n":2}')
    await insert('exploded', '{}')
    await insert('ok', 'not json')
    await insert('ok', '[1,2]')
    await insert('ok', null)
    const rows = await new DatabaseResultStore(() => connection).history()
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.meta)).toContainEqual({ n: 2 })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(rows.every((row) => Object.getPrototypeOf(row.meta) === Object.prototype)).toBe(true)
  })

  it('stores a report atomically: a failing insert leaves nothing behind', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    const store = new DatabaseResultStore(() => connection)
    const bad = createReport('run-bad', T0, [
      { name: 'a', label: 'A', status: 'ok', summary: 'ok', meta: {}, durationMs: 1 },
      // NOT NULL violation on duration_ms makes the second insert fail.
      {
        name: 'b',
        label: 'B',
        status: 'ok',
        summary: 'ok',
        meta: {},
        durationMs: null as unknown as number,
      },
    ])
    await expect(store.save(bad)).rejects.toThrow()
    expect(await store.history()).toEqual([])
  })

  it('fails loudly when the table is missing (the CLI turns it into a hint)', async () => {
    const store = new DatabaseResultStore(() => sqliteConnection())
    await expect(store.save(report('r', T0))).rejects.toThrow(/no such table/)
  })

  it('accepts another table name', async () => {
    const connection = sqliteConnection()
    await migrateHealthTable(connection)
    await connection.run(sql`ALTER TABLE health_check_results RENAME TO ops_health`)
    const store = new DatabaseResultStore(() => connection, { table: 'ops_health' })
    await store.save(report('r', T0))
    expect((await store.latest())?.id).toBe('r')
  })
})

describe('MemoryResultStore', () => {
  it('keeps, lists, prunes and bounds reports', async () => {
    const store = new MemoryResultStore({ maxReports: 2 })
    expect(await store.latest()).toBeUndefined()
    await store.save(report('a', T0))
    await store.save(report('b', T0 + 1000))
    await store.save(report('c', T0 + 2000))
    expect((await store.latest())?.id).toBe('c')
    expect((await store.history()).map((run) => run.batch)).toEqual(['c', 'c', 'b', 'b'])
    expect(await store.history({ check: 'database', limit: 1 })).toHaveLength(1)
    expect(await store.prune(T0 + 1500)).toBe(2)
    expect((await store.history()).map((run) => run.batch)).toEqual(['c', 'c'])
    expect(await new MemoryResultStore().history()).toEqual([])
  })
})
