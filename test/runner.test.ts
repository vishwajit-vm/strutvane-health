import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckContext, HealthCheck } from '../src/check.ts'
import { Result } from '../src/result.ts'
import { DEFAULT_CHECK_TIMEOUT_MS, failureFrom, runChecks } from '../src/runner.ts'
import { contextFor, StepClock } from './helpers.ts'

afterEach(() => {
  vi.useRealTimers()
})

function options(clock = new StepClock(), secrets: readonly string[] = []) {
  return {
    context: (signal: AbortSignal): CheckContext => contextFor({ signal, now: () => clock.now() }),
    timeoutMs: 1000,
    secrets,
    now: () => clock.now(),
  }
}

describe('runChecks', () => {
  it('runs checks concurrently and keeps their order; durations come from the clock', async () => {
    const clock = new StepClock()
    const checks: HealthCheck[] = [
      {
        name: 'slow',
        run: async () => {
          clock.advance(40)
          return Result.ok('done')
        },
      },
      { name: 'fast', label: 'Fast', run: () => Result.warning('meh', 'look at it') },
    ]
    const runs = await runChecks(checks, options(clock))
    expect(runs.map((run) => [run.name, run.label, run.status])).toEqual([
      ['slow', 'slow', 'ok'],
      ['fast', 'Fast', 'warning'],
    ])
    expect(runs[0]?.durationMs).toBe(40)
    expect(runs[1]?.message).toBe('look at it')
  })

  it('turns a throw (sync or async) into failed, with the code and no stack', async () => {
    const runs = await runChecks(
      [
        {
          name: 'sync',
          run: () => {
            throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
              code: 'ECONNREFUSED',
            })
          },
        },
        { name: 'async', run: async () => Promise.reject(new Error('')) },
        {
          name: 'value',
          run: () => {
            throw 'plain string'
          },
        },
      ],
      options(),
    )
    expect(runs[0]).toMatchObject({
      status: 'failed',
      summary: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 10.0.0.1:5432',
    })
    expect(runs[0]?.message).not.toMatch(/at .*\.ts/)
    expect(runs[1]).toMatchObject({
      status: 'failed',
      summary: 'error',
      message: 'The check threw an error.',
    })
    expect(runs[2]).toMatchObject({ status: 'failed', message: 'plain string' })
  })

  it('reports a hung check as failed at its deadline and aborts its signal', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const pending = runChecks(
      [
        {
          name: 'hangs',
          timeoutMs: 250,
          run: (context) => {
            signal = context.signal
            return new Promise(() => undefined)
          },
        },
        { name: 'fine', run: () => Result.ok() },
      ],
      options(),
    )
    await vi.advanceTimersByTimeAsync(250)
    const runs = await pending
    expect(runs[0]).toMatchObject({
      status: 'failed',
      summary: 'timed out after 250 ms',
      meta: { timeoutMs: 250 },
    })
    expect(signal?.aborted).toBe(true)
    expect(runs[1]?.status).toBe('ok')
  })

  it('uses the default deadline when a check sets none', async () => {
    vi.useFakeTimers()
    const pending = runChecks([{ name: 'hangs', run: () => new Promise(() => undefined) }], {
      ...options(),
      timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_TIMEOUT_MS)
    expect((await pending)[0]?.summary).toBe(`timed out after ${DEFAULT_CHECK_TIMEOUT_MS} ms`)
  })

  it('reports garbage results as failed instead of trusting them', async () => {
    const garbage = (value: unknown): HealthCheck => ({ name: 'g', run: () => value as never })
    const [none] = await runChecks([garbage(undefined)], options())
    const [unknown] = await runChecks([garbage({ status: 'great' })], options())
    const [partial] = await runChecks(
      [garbage({ status: 'ok', meta: null, summary: 3 })],
      options(),
    )
    expect(none).toMatchObject({ status: 'failed', message: 'Check "g" returned no result.' })
    expect(unknown).toMatchObject({ status: 'failed', summary: 'invalid result' })
    expect(partial).toMatchObject({ status: 'ok', summary: 'ok', meta: {} })
  })

  it('masks secrets in everything a check returns or throws', async () => {
    const secret = randomBytes(16).toString('hex')
    const runs = await runChecks(
      [
        {
          name: 'returns',
          run: () => Result.failed(`bad ${secret}`, `msg ${secret}`, { detail: secret }),
        },
        {
          name: 'throws',
          run: () => {
            throw new Error(`failed with postgres://u:${secret}@db/app`)
          },
        },
      ],
      options(new StepClock(), [secret]),
    )
    expect(JSON.stringify(runs)).not.toContain(secret)
  })
})

describe('failureFrom', () => {
  it('uses the code when there is one', () => {
    expect(failureFrom(Object.assign(new Error('x'), { code: 'EACCES' })).summary).toBe('EACCES')
    expect(failureFrom(new Error('x')).summary).toBe('error')
  })
})
