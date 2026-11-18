import { describe, expect, it } from 'vitest'
import { createReport, publicReport } from '../src/report.ts'
import {
  HEALTH_STATUSES,
  isHealthStatus,
  Result,
  severity,
  thresholdProblem,
  thresholdStatus,
  worstStatus,
} from '../src/result.ts'

describe('Result', () => {
  it('builds each status, with optional message and meta', () => {
    expect(Result.ok()).toEqual({ status: 'ok', summary: 'ok', meta: {} })
    expect(Result.ok('3 ms', { latencyMs: 3 })).toEqual({
      status: 'ok',
      summary: '3 ms',
      meta: { latencyMs: 3 },
    })
    expect(Result.warning('slow')).toEqual({ status: 'warning', summary: 'slow', meta: {} })
    expect(Result.failed('down', 'fix it', { a: 1 })).toEqual({
      status: 'failed',
      summary: 'down',
      message: 'fix it',
      meta: { a: 1 },
    })
    expect(Result.skipped('n/a')).toEqual({ status: 'skipped', summary: 'n/a', meta: {} })
  })
})

describe('statuses', () => {
  it('orders severities and picks the worst; skipped never hurts', () => {
    expect(HEALTH_STATUSES).toEqual(['ok', 'skipped', 'warning', 'failed'])
    expect(severity('skipped')).toBe(severity('ok'))
    expect(worstStatus([])).toBe('ok')
    expect(worstStatus(['ok', 'skipped'])).toBe('ok')
    expect(worstStatus(['ok', 'warning', 'skipped'])).toBe('warning')
    expect(worstStatus(['warning', 'failed', 'ok'])).toBe('failed')
  })

  it('recognises statuses', () => {
    expect(isHealthStatus('warning')).toBe(true)
    expect(isHealthStatus('WARNING')).toBe(false)
    expect(isHealthStatus(1)).toBe(false)
  })
})

describe('thresholds', () => {
  it('rates a value: below warn ok, at warn warning, at fail failed', () => {
    const limits = { warnAt: 100, failAt: 1000 }
    expect(thresholdStatus(99, limits)).toBe('ok')
    expect(thresholdStatus(100, limits)).toBe('warning')
    expect(thresholdStatus(999, limits)).toBe('warning')
    expect(thresholdStatus(1000, limits)).toBe('failed')
    expect(thresholdStatus(Number.NaN, limits)).toBe('failed')
    expect(thresholdStatus(Number.POSITIVE_INFINITY, limits)).toBe('failed')
  })

  it('names unusable thresholds', () => {
    expect(thresholdProblem({ warnAt: 1, failAt: 2 })).toBeUndefined()
    expect(thresholdProblem({ warnAt: 2, failAt: 2 })).toBeUndefined()
    expect(thresholdProblem({ warnAt: 3, failAt: 2 })).toMatch(/must not be above/)
    expect(thresholdProblem({ warnAt: -1, failAt: 2 })).toMatch(/warnAt/)
    expect(thresholdProblem({ warnAt: 1, failAt: Number.NaN })).toMatch(/failAt/)
  })
})

describe('reports', () => {
  const runs = [
    {
      name: 'a',
      label: 'A',
      status: 'ok' as const,
      summary: 'fine',
      meta: { x: 1 },
      durationMs: 2,
    },
    {
      name: 'b',
      label: 'B',
      status: 'failed' as const,
      summary: 'down',
      message: 'details',
      meta: { y: 'z' },
      durationMs: 5,
    },
  ]

  it('derives the overall status from the checks', () => {
    const report = createReport('id', Date.UTC(2026, 0, 1), runs)
    expect(report.status).toBe('failed')
    expect(report.finishedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('serves no meta, and messages only when asked', () => {
    const report = createReport('id', 0, runs)
    const hidden = JSON.stringify(publicReport(report, { messages: false }))
    expect(hidden).not.toContain('details')
    expect(hidden).not.toContain('"meta"')
    expect(hidden).not.toContain('"id"')
    const shown = publicReport(report, { messages: true })
    expect(JSON.stringify(shown)).toContain('details')
    expect(JSON.stringify(shown)).not.toContain('"meta"')
  })
})
