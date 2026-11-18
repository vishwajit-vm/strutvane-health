import { createCacheManager } from '@strutvane/framework'
import { describe, expect, it } from 'vitest'
import type { HealthNotification, NotificationChannel } from '../../src/notify/channels.ts'
import { NOTIFY_PREFIX, Notifier } from '../../src/notify/notifier.ts'
import { type CheckRun, createReport } from '../../src/report.ts'
import type { HealthStatus } from '../../src/result.ts'
import { MemoryLogger, StepClock, tempDir } from '../helpers.ts'

function run(name: string, status: HealthStatus): CheckRun {
  return {
    name,
    label: name.toUpperCase(),
    status,
    summary: `${name} ${status}`,
    meta: {},
    durationMs: 1,
  }
}

function setup(
  options: { on?: 'warning' | 'failed'; recovery?: boolean; channels?: NotificationChannel[] } = {},
) {
  const clock = new StepClock()
  const cache = createCacheManager({
    basePath: tempDir(),
    clock,
    config: { default: 'memory' },
  }).store()
  const sent: HealthNotification[] = []
  const recorder: NotificationChannel = { name: 'recorder', send: async (n) => void sent.push(n) }
  const logger = new MemoryLogger()
  const notifier = new Notifier({
    channels: options.channels ?? [recorder],
    cache,
    logger,
    appName: 'Blog',
    environment: 'production',
    throttleMinutes: 10,
    ...(options.on === undefined ? {} : { on: options.on }),
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
  })
  const report = (...runs: CheckRun[]) => createReport('r', clock.now(), runs)
  return { clock, cache, sent, logger, notifier, report }
}

describe('Notifier', () => {
  it('alerts on failures with a clear subject, and only those at the alert level', async () => {
    const { notifier, sent, report } = setup()
    const outcome = await notifier.notify(
      report(run('database', 'failed'), run('disk-space', 'warning'), run('cache', 'ok')),
    )
    expect(outcome).toEqual({
      alerted: ['database'],
      recovered: [],
      suppressed: [],
      failedChannels: [],
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe('[Blog, production] Health: failed (database)')
    expect(sent[0]?.text).toBe('DATABASE: failed, database failed')
    expect(sent[0]?.checks).toEqual([
      { name: 'database', label: 'DATABASE', status: 'failed', summary: 'database failed' },
    ])
  })

  it('alerts on warnings when configured', async () => {
    const { notifier, report } = setup({ on: 'warning' })
    expect((await notifier.notify(report(run('disk-space', 'warning')))).alerted).toEqual([
      'disk-space',
    ])
  })

  it('throttles repeats per check and status; a worse status alerts at once', async () => {
    const { notifier, sent, report, clock } = setup({ on: 'warning' })
    await notifier.notify(report(run('database', 'warning')))
    const repeat = await notifier.notify(report(run('database', 'warning')))
    expect(repeat.suppressed).toEqual(['database'])
    const worse = await notifier.notify(report(run('database', 'failed')))
    expect(worse.alerted).toEqual(['database'])
    expect(sent).toHaveLength(2)
    clock.advance(10 * 60_000)
    expect((await notifier.notify(report(run('database', 'failed')))).alerted).toEqual(['database'])
  })

  it('two notifiers sharing a cache (two servers) send one alert', async () => {
    const first = setup()
    const sent: HealthNotification[] = []
    const second = new Notifier({
      channels: [{ name: 'other', send: async (n) => void sent.push(n) }],
      cache: first.cache,
      logger: new MemoryLogger(),
      appName: 'Blog',
      environment: 'production',
    })
    await Promise.all([
      first.notifier.notify(first.report(run('database', 'failed'))),
      second.notify(first.report(run('database', 'failed'))),
    ])
    expect(first.sent.length + sent.length).toBe(1)
  })

  it('sends one recovery after a check that alerted is ok again, and re-arms', async () => {
    const { notifier, sent, report } = setup()
    await notifier.notify(report(run('database', 'failed')))
    const recovered = await notifier.notify(report(run('database', 'ok')))
    expect(recovered.recovered).toEqual(['database'])
    expect(sent[1]?.subject).toBe('[Blog, production] Health: recovered (database)')
    expect(sent[1]?.status).toBe('ok')
    expect((await notifier.notify(report(run('database', 'ok')))).recovered).toEqual([])
    expect((await notifier.notify(report(run('database', 'failed')))).alerted).toEqual(['database'])
  })

  it('can skip recovery messages', async () => {
    const { notifier, sent, report } = setup({ recovery: false })
    await notifier.notify(report(run('database', 'failed')))
    expect((await notifier.notify(report(run('database', 'ok')))).recovered).toEqual(['database'])
    expect(sent).toHaveLength(1)
  })

  it('one broken channel never stops the others; logs name and code only', async () => {
    const secretUrl = 'https://hooks.slack.com/services/T/B/very-secret'
    const delivered: string[] = []
    const { notifier, report, logger } = setup({
      channels: [
        {
          name: 'slack',
          send: async () => {
            throw Object.assign(new Error(`POST ${secretUrl} failed`), {
              code: 'connection_failed',
            })
          },
        },
        { name: 'mail', send: async (n) => void delivered.push(n.subject) },
      ],
    })
    const outcome = await notifier.notify(report(run('database', 'failed')))
    expect(outcome.failedChannels).toEqual(['slack'])
    expect(delivered).toHaveLength(1)
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'health: alert delivery failed',
      fields: { channel: 'slack', error: 'connection_failed' },
    })
    expect(logger.dump()).not.toContain('very-secret')
  })

  it('fails open to "send" when the throttle store is down', async () => {
    const sent: HealthNotification[] = []
    const broken = createCacheManager({ basePath: tempDir(), clock: new StepClock() }).store()
    const notifier = new Notifier({
      channels: [{ name: 'r', send: async (n) => void sent.push(n) }],
      cache: {
        ...broken,
        add: async () => {
          throw new Error('cache down')
        },
        put: async () => {
          throw new Error('cache down')
        },
      },
      logger: new MemoryLogger(),
      appName: 'Blog',
      environment: 'production',
    })
    const outcome = await notifier.notify(createReport('r', 0, [run('database', 'failed')]))
    expect(outcome.alerted).toEqual(['database'])
    expect(sent).toHaveLength(1)
  })

  it('validates the throttle and exposes its channels and key prefix', () => {
    const { cache } = setup()
    expect(
      () =>
        new Notifier({
          channels: [],
          cache,
          logger: new MemoryLogger(),
          appName: 'a',
          environment: 'e',
          throttleMinutes: 0,
        }),
    ).toThrow(/throttleMinutes/)
    expect(setup().notifier.channels.map((channel) => channel.name)).toEqual(['recorder'])
    expect(NOTIFY_PREFIX).toBe('health:notify:')
  })
})
