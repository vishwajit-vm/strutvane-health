/**
 * The JSON endpoint on a real, booted Application (the framework's kernel, middleware and error
 * renderer). Attack-style: no access without a token or policy, constant-time token check,
 * brute-force limit, query-string tokens ignored, no secrets or details leaked, /up untouched.
 */
import { randomBytes } from 'node:crypto'
import { DatabaseConnectionToken } from '@strutvane/framework'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { defineCheck } from '../../src/check.ts'
import { HealthToken } from '../../src/health.ts'
import { presentedToken } from '../../src/http/endpoint.ts'
import { Result } from '../../src/result.ts'
import { healthApp, TOKEN } from '../helpers.ts'

const URL_BASE = 'http://localhost'

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${URL_BASE}${path}`, { headers })
}

async function booted(
  health: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string>> = {},
) {
  const fixture = healthApp({ health, env })
  await fixture.app.boot()
  return fixture
}

const withToken = { endpoint: { token: TOKEN } }
const bearer = { authorization: `Bearer ${TOKEN}` }

describe('GET /health.json', () => {
  it('answers 404 when neither a token nor a policy is configured (never public by default)', async () => {
    const { app } = await booted()
    const response = await app.handle(get('/health.json'))
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('database')
  })

  it('keeps /up as the public liveness probe', async () => {
    const { app } = await booted(withToken)
    const response = await app.handle(get('/up'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('serves the report to the right bearer token, with no-store and no messages or meta', async () => {
    const { app } = await booted(withToken)
    const response = await app.handle(get('/health.json', bearer))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await response.json()) as {
      status: string
      checks: { name: string; message?: string; meta?: unknown }[]
    }
    expect(body.checks.map((check) => check.name)).toEqual([
      'database',
      'migrations',
      'cache',
      'disk-space',
      'storage',
      'app-key',
      'debug-mode',
      'environment',
    ])
    expect(
      body.checks.every((check) => check.message === undefined && check.meta === undefined),
    ).toBe(true)
    expect([200, 503]).toContain(response.status)
    expect(response.status).toBe(body.status === 'failed' ? 503 : 200)
  })

  it('accepts X-Health-Token too, ignores a token in the query string', async () => {
    const { app } = await booted(withToken)
    expect((await app.handle(get('/health.json', { 'x-health-token': TOKEN }))).status).not.toBe(
      401,
    )
    const query = await app.handle(get(`/health.json?token=${TOKEN}`))
    expect(query.status).toBe(401)
  })

  it('refuses wrong, missing, malformed and near-miss tokens with 401 + WWW-Authenticate', async () => {
    const { app } = await booted(withToken)
    for (const headers of [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: `Basic ${TOKEN}` },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Bearer ${TOKEN.toUpperCase()}` },
      { 'x-health-token': ' ' },
    ]) {
      const response = await app.handle(get('/health.json', headers))
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="health"')
      expect(response.headers.get('content-type')).toMatch(/problem\+json/)
    }
  })

  it('answers 429 to further failures from a client after max_failed_attempts, and still serves the right token', async () => {
    const { app } = await booted({ endpoint: { token: TOKEN, max_failed_attempts: 3 } })
    const wrong = { authorization: 'Bearer nope' }
    for (let i = 0; i < 3; i += 1)
      expect((await app.handle(get('/health.json', wrong), { ip: '203.0.113.9' })).status).toBe(401)
    const locked = await app.handle(get('/health.json', wrong), { ip: '203.0.113.9' })
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBe('60')
    // The right token from the same client is checked first and always served.
    expect([200, 503]).toContain(
      (await app.handle(get('/health.json', bearer), { ip: '203.0.113.9' })).status,
    )
    // Another client's failures are counted separately.
    expect((await app.handle(get('/health.json', wrong), { ip: '198.51.100.7' })).status).toBe(401)
  })

  it('a valid token is never refused, whatever failures its client bucket has seen (property)', async () => {
    const { app } = await booted({ endpoint: { token: TOKEN, max_failed_attempts: 2 } })
    const client = fc.oneof(
      fc.constant('unknown'),
      fc.ipV4(),
      fc.ipV6(),
      fc.ipV4().map((v4) => `::ffff:${v4}`),
    )
    const wrongHeaders = fc.oneof(
      fc.constant<Record<string, string>>({}),
      fc
        .stringMatching(/^[A-Za-z0-9._~+/=-]{1,60}$/)
        .filter((token) => token !== TOKEN)
        .map((token) => ({ authorization: `Bearer ${token}` })),
      fc.constant({ 'x-health-token': `${TOKEN}x` }),
    )
    await fc.assert(
      fc.asyncProperty(client, fc.array(wrongHeaders, { maxLength: 12 }), async (ip, attempts) => {
        for (const headers of attempts) {
          const refused = await app.handle(get('/health.json', headers), { ip })
          expect([401, 429]).toContain(refused.status)
        }
        const served = await app.handle(get('/health.json', bearer), { ip })
        expect([200, 503]).toContain(served.status)
        const viaHeader = await app.handle(get('/health.json', { 'x-health-token': TOKEN }), { ip })
        expect([200, 503]).toContain(viaHeader.status)
      }),
      { numRuns: 40 },
    )
  })

  it('an allowed policy is never refused, whatever failures its client bucket has seen', async () => {
    const { app } = await booted()
    app
      .make(HealthToken)
      .authorizeUsing((ctx) => ctx.request.headers.get('x-role') === 'admin')
    for (const ip of [undefined, 'unknown', '203.0.113.9', '2001:db8::1']) {
      const info = ip === undefined ? {} : { ip }
      for (let i = 0; i < 25; i += 1)
        expect([401, 429]).toContain(
          (await app.handle(get('/health.json', { 'x-role': 'guest' }), info)).status,
        )
      expect([200, 503]).toContain(
        (await app.handle(get('/health.json', { 'x-role': 'admin' }), info)).status,
      )
    }
  })

  it('counts failures per client bucket: one IPv6 /64, and IPv4-mapped IPv6 as its IPv4 client', async () => {
    const { app } = await booted({ endpoint: { token: TOKEN, max_failed_attempts: 2 } })
    const wrong = { authorization: 'Bearer nope' }
    const status = async (ip: string) => (await app.handle(get('/health.json', wrong), { ip })).status
    // Two addresses in one /64 share a bucket; a third in that /64 is over the limit.
    expect(await status('2001:db8:1:2::1')).toBe(401)
    expect(await status('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(401)
    expect(await status('2001:db8:1:2:abcd::9')).toBe(429)
    // A neighbouring /64 is a different client.
    expect(await status('2001:db8:1:3::1')).toBe(401)
    // IPv4 and its IPv4-mapped form are one client.
    expect(await status('192.0.2.44')).toBe(401)
    expect(await status('::ffff:192.0.2.44')).toBe(401)
    expect(await status('[::ffff:c000:22c]')).toBe(429)
    expect(await status('192.0.2.45')).toBe(401)
  })

  it('answers 503 when a check fails, and never leaks secrets even with messages exposed', async () => {
    const password = randomBytes(16).toString('hex')
    const { app } = await booted(
      { endpoint: { token: TOKEN, expose_messages: true } },
      { DB_PASSWORD: password },
    )
    app.make(HealthToken).register(
      defineCheck({
        name: 'leaky',
        run: () => {
          throw new Error(`connect postgres://app:${password}@10.0.0.9/app failed, token=${TOKEN}`)
        },
      }),
    )
    const response = await app.handle(get('/health.json', bearer))
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).toContain('leaky')
    expect(text).toContain('"message"')
    expect(text).not.toContain(password)
    expect(text).not.toContain(TOKEN)
  })

  it('lets a policy grant access without the token; a throwing policy denies', async () => {
    const { app, logger } = await booted()
    const health = app.make(HealthToken)
    health.authorizeUsing((ctx) => ctx.request.headers.get('x-role') === 'admin')
    expect((await app.handle(get('/health.json', { 'x-role': 'admin' }))).status).not.toBe(401)
    expect((await app.handle(get('/health.json', { 'x-role': 'guest' }))).status).toBe(401)
    health.authorizeUsing(() => {
      throw new TypeError('policy bug')
    })
    expect((await app.handle(get('/health.json', { 'x-role': 'admin' }))).status).toBe(401)
    expect(logger.entries.some((entry) => entry.message.includes('policy threw'))).toBe(true)
  })

  it('reuses a recent report instead of re-running checks for every request', async () => {
    const { app, clock } = await booted({ endpoint: { token: TOKEN, cache_seconds: 30 } })
    let runs = 0
    app.make(HealthToken).register(
      defineCheck({
        name: 'counted',
        run: () => {
          runs += 1
          return Result.ok()
        },
      }),
    )
    await Promise.all([1, 2, 3].map(() => app.handle(get('/health.json', bearer))))
    expect(runs).toBe(1)
    clock.advance(31_000)
    await app.handle(get('/health.json', bearer))
    expect(runs).toBe(2)
  })

  it('can be moved or turned off', async () => {
    const moved = await booted({ endpoint: { token: TOKEN, path: '/ops/health' } })
    expect((await moved.app.handle(get('/ops/health', bearer))).status).not.toBe(404)
    expect((await moved.app.handle(get('/health.json', bearer))).status).toBe(404)
    const off = await booted({ endpoint: { token: TOKEN, enabled: false } })
    expect((await off.app.handle(get('/health.json', bearer))).status).toBe(404)
  })

  it('only answers GET (and HEAD)', async () => {
    const { app } = await booted(withToken)
    const post = await app.handle(
      new Request(`${URL_BASE}/health.json`, { method: 'POST', headers: bearer }),
    )
    expect([404, 405, 419]).toContain(post.status)
  })
})

describe('presentedToken', () => {
  it('reads Bearer (any case, surrounding blanks) and X-Health-Token', () => {
    const request = (headers: Record<string, string>) => new Request(URL_BASE, { headers })
    expect(presentedToken(request({ authorization: 'bearer   abc ' }))).toBe('abc')
    expect(presentedToken(request({ authorization: 'Bearer a b' }))).toBeUndefined()
    expect(presentedToken(request({ authorization: 'Token abc', 'x-health-token': ' xyz ' }))).toBe(
      'xyz',
    )
    expect(presentedToken(request({}))).toBeUndefined()
  })
})

describe('the provider', () => {
  it('stores history in the results table when the database has it', async () => {
    const fixture = healthApp()
    const { migrateHealthTable } = await import('../helpers.ts')
    await migrateHealthTable(fixture.connection)
    await fixture.app.boot()
    const health = fixture.app.make(HealthToken)
    const outcome = await fixture.app.run(() => health.run({ notify: false }))
    expect(outcome.stored).toBe(true)
    expect((await health.store?.latest())?.id).toBe(outcome.report.id)
    expect(fixture.app.make(DatabaseConnectionToken)).toBe(fixture.connection)
  })

  it('builds the notifier from settings; mail without a transport is off with a warning', async () => {
    const { app, logger } = await booted({
      notifications: {
        slack_webhook_url: 'https://hooks.slack.com/services/T/B/x',
        mail_to: 'ops@example.com',
      },
    })
    const health = app.make(HealthToken)
    expect(health.list().length).toBeGreaterThan(0)
    expect(logger.entries.some((entry) => entry.message.includes('no HealthMailerToken'))).toBe(
      true,
    )
  })

  it('stops the boot on an invalid config, naming the key', async () => {
    const fixture = healthApp({ health: { endpoint: { token: 'short' } } })
    await expect(fixture.app.boot()).rejects.toThrow(/health\.endpoint\.token/)
  })
})
