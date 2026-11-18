import { randomBytes } from 'node:crypto'
import { isBootError } from '@strutvane/framework'
import { describe, expect, it } from 'vitest'
import { defineCheck, type HealthCheck } from '../src/check.ts'
import { Health, type HealthOptions, UnknownCheckError } from '../src/health.ts'
import { MemoryResultStore, type ResultStore } from '../src/history/store.ts'
import type { Notifier } from '../src/notify/notifier.ts'
import { Result } from '../src/result.ts'
import { contextFor, MemoryLogger, StepClock } from './helpers.ts'

function make(options: Partial<HealthOptions> = {}) {
  const clock = new StepClock()
  const logger = new MemoryLogger()
  const health = new Health({
    context: (signal) => contextFor({ signal, now: () => clock.now() }),
    env: {},
    now: () => clock.now(),
    logger,
    ...options,
  })
  return { health, clock, logger }
}

const ok = (name: string): HealthCheck => defineCheck({ name, run: () => Result.ok() })

describe('Health', () => {
  it('registers, lists, forgets and refuses duplicates or invalid checks', () => {
    const { health } = make()
    health.register(ok('a'), ok('b'))
    expect(health.list().map((check) => check.name)).toEqual(['a', 'b'])
    expect(() => health.register(ok('a'))).toThrow(/already registered/)
    let thrown: unknown
    try {
      health.register({ name: 'Nope', run: () => Result.ok() })
    } catch (error) {
      thrown = error
    }
    expect(isBootError(thrown)).toBe(true)
    health.forget('a').register(ok('a'))
    expect(health.list().map((check) => check.name)).toEqual(['b', 'a'])
  })

  it('runs the checks, stores the report and prunes old history', async () => {
    const store = new MemoryResultStore()
    const { health, clock } = make({ store, keepDays: 1 })
    health.register(ok('a'))
    const first = await health.run()
    expect(first).toMatchObject({ stored: true, notified: undefined, problems: [] })
    clock.advance(2 * 86_400_000)
    await health.run()
    expect((await store.history()).map((row) => row.batch)).toEqual([(await store.latest())?.id])
    expect(first.report.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('runs only the named checks; unknown names list the known ones', async () => {
    const { health } = make()
    health.register(ok('a'), ok('b'))
    expect((await health.run({ only: ['b'] })).report.checks.map((run) => run.name)).toEqual(['b'])
    await expect(health.run({ only: ['b', 'zz'] })).rejects.toThrow(UnknownCheckError)
    await expect(health.run({ only: ['zz'] })).rejects.toThrow(
      'Unknown health check(s): zz. Registered: a, b.',
    )
    expect(new UnknownCheckError(['x'], []).message).toContain('Registered: none')
  })

  it('skips history and alerts when asked', async () => {
    const store = new MemoryResultStore()
    let notified = 0
    const notifier = {
      notify: async () => {
        notified += 1
        return { alerted: [], recovered: [], suppressed: [], failedChannels: [] }
      },
    } as unknown as Notifier
    const { health } = make({ store, notifier })
    health.register(ok('a'))
    const outcome = await health.run({ store: false, notify: false })
    expect(outcome.stored).toBe(false)
    expect(await store.latest()).toBeUndefined()
    expect(notified).toBe(0)
    await health.run()
    expect(notified).toBe(1)
  })

  it('reports history and alert failures as sanitized problems, never throws for them', async () => {
    const secret = randomBytes(12).toString('hex')
    const store: ResultStore = {
      save: async () => {
        throw new Error(`no such table: health_check_results (postgres://u:${secret}@db/x)`)
      },
      latest: async () => undefined,
      history: async () => [],
      prune: async () => 0,
    }
    const notifier = {
      notify: async () => ({
        alerted: ['a'],
        recovered: [],
        suppressed: [],
        failedChannels: ['slack'],
      }),
    } as unknown as Notifier
    const { health, logger } = make({ store, notifier, env: { DB_PASSWORD: secret } })
    health.register(ok('a'))
    const outcome = await health.run()
    expect(outcome.stored).toBe(false)
    expect(outcome.problems[0]).toMatch(/^history: no such table: health_check_results/)
    expect(outcome.problems).toContain('alerts: slack failed')
    expect(JSON.stringify(outcome)).not.toContain(secret)
    expect(logger.dump()).not.toContain(secret)
    const nonError: ResultStore = { ...store, save: async () => Promise.reject({ code: 'EBUSY' }) }
    const second = make({ store: nonError })
    second.health.register(ok('a'))
    expect((await second.health.run()).problems).toEqual(['history: EBUSY'])
  })

  it('current(): reuses a fresh report and shares one run between concurrent callers', async () => {
    let runs = 0
    const { health, clock } = make()
    health.register(
      defineCheck({
        name: 'counted',
        run: async () => {
          runs += 1
          await new Promise((resolve) => setImmediate(resolve))
          return Result.ok()
        },
      }),
    )
    const [a, b, c] = await Promise.all([
      health.current(10_000),
      health.current(10_000),
      health.current(10_000),
    ])
    expect(runs).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    clock.advance(5_000)
    expect(await health.current(10_000)).toBe(a)
    clock.advance(5_000)
    expect(await health.current(10_000)).not.toBe(a)
    expect(runs).toBe(2)
    expect(await health.current(0)).not.toBe(a)
  })

  it('keeps the endpoint policy', () => {
    const { health } = make()
    expect(health.authorizer).toBeUndefined()
    const policy = () => true
    expect(health.authorizeUsing(policy).authorizer).toBe(policy)
    expect(health.store).toBeUndefined()
  })
})
