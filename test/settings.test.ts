import { randomBytes } from 'node:crypto'
import { isBootError } from '@strutvane/framework'
import { describe, expect, it } from 'vitest'
import { MIN_TOKEN_LENGTH, resolveHealthSettings } from '../src/settings.ts'

function problems(raw: unknown): string {
  try {
    resolveHealthSettings(raw)
  } catch (error) {
    expect(isBootError(error)).toBe(true)
    return (error as Error).message
  }
  throw new Error('expected a BootError')
}

describe('resolveHealthSettings', () => {
  it('fills safe defaults; the endpoint has no token (it answers nobody)', () => {
    const settings = resolveHealthSettings(undefined)
    expect(settings.endpoint).toEqual({
      enabled: true,
      path: '/health.json',
      token: '',
      exposeMessages: false,
      cacheSeconds: 10,
      maxFailedAttempts: 10,
    })
    expect(settings.history).toEqual({ enabled: true, keepDays: 7 })
    expect(settings.notifications.on).toBe('failed')
    expect(settings.checks.storage.paths).toEqual(['storage/framework', 'storage/logs'])
    expect(settings.checks.cache.store).toBeUndefined()
  })

  it('reads every key', () => {
    const token = randomBytes(32).toString('base64url')
    const settings = resolveHealthSettings({
      timeout_ms: 2000,
      endpoint: {
        path: '/ops/health',
        token,
        expose_messages: true,
        cache_seconds: 0,
        max_failed_attempts: 3,
      },
      history: { enabled: false, keep_days: 30 },
      checks: {
        database: { warn_ms: 10, fail_ms: 20 },
        cache: { store: 'file' },
        disk_space: { path: 'var', warn_percent: 50, fail_percent: 60 },
        storage: { paths: [' storage/app ', ''], disk: 'local' },
        environment: { ignore: ['A'], required: ['B'] },
        heartbeats: ['scheduler'],
      },
      notifications: {
        on: 'warning',
        throttle_minutes: 5,
        recovery: false,
        slack_webhook_url: 'https://hooks.slack.com/services/x',
        mail_to: 'a@example.com, b@example.com,',
      },
    })
    expect(settings.timeoutMs).toBe(2000)
    expect(settings.endpoint.token).toBe(token)
    expect(settings.checks.storage.paths).toEqual(['storage/app'])
    expect(settings.notifications.mailTo).toEqual(['a@example.com', 'b@example.com'])
    expect(settings.notifications.on).toBe('warning')
  })

  it('reports every problem at once, naming the key', () => {
    const message = problems({
      timeout_ms: 0,
      endpoint: { path: 'health', expose_messages: 'yes' },
      history: 'on',
      checks: {
        database: { warn_ms: 500, fail_ms: 100 },
        storage: { paths: [1] },
        disk_space: { warn_percent: 95, fail_percent: 90 },
      },
      notifications: { on: 'always', throttle_minutes: 0, slack_webhook_url: 3 },
    })
    for (const key of [
      'health.timeout_ms',
      'health.endpoint.path',
      'health.endpoint.expose_messages',
      'health.history must be an object',
      'warn_ms must not be above fail_ms',
      'health.checks.storage.paths',
      'warn_percent must not be above fail_percent',
      'health.notifications.on must be one of: failed, warning',
      'health.notifications.throttle_minutes',
      'health.notifications.slack_webhook_url must be a string',
    ])
      expect(message).toContain(key)
  })

  it('refuses a short token without echoing it', () => {
    const short = 'abc123secret'
    const message = problems({ endpoint: { token: short } })
    expect(message).toContain(`at least ${MIN_TOKEN_LENGTH} characters`)
    expect(message).not.toContain(short)
  })

  it('never lets the endpoint take /up or an unsafe path', () => {
    expect(problems({ endpoint: { path: '/up' } })).toContain('liveness probe')
    expect(problems({ endpoint: { path: '/up/' } })).toContain('liveness probe')
    expect(problems({ endpoint: { path: '/a/../b' } })).toContain('plain path')
    expect(problems({ endpoint: { path: '//evil' } })).toContain('plain path')
    expect(problems({ endpoint: [] })).toContain('health.endpoint must be an object')
  })
})
