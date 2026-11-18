/**
 * The provider's wiring end to end: alerts from a failed run reach every configured channel
 * (through the app's own HttpClient, faked), mail needs a bound transport, and the environment
 * comes from `.env` when nothing is bound.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpClient, HttpClientToken } from '@strutvane/framework'
import { describe, expect, it } from 'vitest'
import { defineCheck } from '../src/check.ts'
import { HealthToken } from '../src/health.ts'
import { HealthEnvToken, HealthMailerToken } from '../src/provider.ts'
import { Result } from '../src/result.ts'
import { healthApp } from './helpers.ts'

const SLACK = 'https://hooks.slack.com/services/T/B/provider-test'

describe('HealthServiceProvider', () => {
  it('sends a failed run to Slack, the webhook (signed) and mail, once', async () => {
    const fixture = healthApp({
      health: {
        checks: { database: { enabled: false }, migrations: { enabled: false } },
        history: { enabled: false },
        notifications: {
          slack_webhook_url: SLACK,
          webhook_url: 'https://ops.example.com/hooks/health',
          webhook_secret: 's'.repeat(40),
          mail_to: 'ops@example.com',
        },
      },
    })
    const http = new HttpClient().fake(() => ({ status: 200 }))
    const mails: string[] = []
    fixture.app.container.value(HttpClientToken, http)
    fixture.app.container.value(HealthMailerToken, {
      send: async (mail) => void mails.push(mail.subject),
    })
    await fixture.app.boot()
    const health = fixture.app.make(HealthToken)
    health.register(defineCheck({ name: 'payments', run: () => Result.failed('down') }))
    const first = await fixture.app.run(() => health.run())
    expect(first.notified?.alerted).toContain('payments')
    expect(first.notified?.failedChannels).toEqual([])
    http.assertSent((request) => request.url === SLACK)
    http.assertSent(
      (request) => request.headers.get('x-health-signature')?.startsWith('sha256=') === true,
    )
    expect(mails).toEqual([expect.stringContaining('[Health Test, testing] Health: failed')])
    const second = await fixture.app.run(() => health.run())
    expect(second.notified?.suppressed).toContain('payments')
    expect(mails).toHaveLength(1)
  })

  it('reads the environment from .env and the process when no env is bound', async () => {
    const fixture = healthApp({
      health: { checks: { database: { enabled: false } } },
      bindEnv: false,
    })
    writeFileSync(join(fixture.basePath, '.env'), 'HEALTH_ONLY_IN_DOTENV=present\n')
    // PATH comes from the process environment, the other key only from .env.
    writeFileSync(join(fixture.basePath, '.env.example'), 'HEALTH_ONLY_IN_DOTENV=\nPATH=\n')
    await fixture.app.boot()
    expect(fixture.app.container.has(HealthEnvToken)).toBe(false)
    const health = fixture.app.make(HealthToken)
    const outcome = await fixture.app.run(() => health.run({ only: ['environment'], store: false }))
    expect(outcome.report.checks[0]).toMatchObject({ status: 'ok', summary: '2 set' })
  })
})
