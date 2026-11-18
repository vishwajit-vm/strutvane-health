/**
 * Security of alert delivery: HTTPS only, Slack host pinned, no credentials in URLs, the SSRF
 * guard of the framework's HttpClient always on, webhook URLs never echoed, signed webhooks, and
 * no header injection through mail subjects.
 */
import { HttpClient, isBootError } from '@strutvane/framework'
import { describe, expect, it } from 'vitest'
import {
  type HealthNotification,
  mailChannel,
  signature,
  slackChannel,
  webhookChannel,
  webhookUrl,
} from '../../src/notify/channels.ts'

const notification: HealthNotification = {
  subject: '[Blog, production] Health: failed (database)',
  text: 'Database: failed, <!channel> & unreachable',
  status: 'failed',
  checks: [{ name: 'database', label: 'Database', status: 'failed', summary: 'unreachable' }],
}

function bootMessage(make: () => unknown): string {
  try {
    make()
  } catch (error) {
    expect(isBootError(error)).toBe(true)
    return (error as Error).message
  }
  throw new Error('expected a BootError')
}

const SLACK = 'https://hooks.slack.com/services/T000/B000/secretpart123'

describe('webhook URLs', () => {
  it('accept https only, without credentials, on the pinned host; never echo the URL', () => {
    expect(webhookUrl(SLACK, 'f', 'hooks.slack.com').hostname).toBe('hooks.slack.com')
    for (const [url, problem] of [
      ['not a url', 'not valid'],
      ['http://hooks.slack.com/services/secretpart123', 'https://'],
      ['https://user:pw@hooks.slack.com/x', 'user name or password'],
      ['https://evil.example/secretpart123', 'must point at hooks.slack.com'],
      ['file:///etc/passwd', 'https://'],
    ] as const) {
      const message = bootMessage(() => webhookUrl(url, 'slackChannel', 'hooks.slack.com'))
      expect(message).toContain(problem)
      expect(message).not.toContain('secretpart123')
      expect(message).not.toContain('pw@')
    }
  })
})

describe('slackChannel', () => {
  it('posts the escaped message through the HttpClient', async () => {
    const http = new HttpClient().fake({ 'hooks.slack.com/*': { status: 200, body: 'ok' } })
    await slackChannel({ url: SLACK, http }).send(notification)
    http.assertSent((request) => {
      const body = request.json() as { text: string }
      return (
        request.method === 'POST' &&
        request.url === SLACK &&
        body.text.includes('&lt;!channel&gt; &amp; unreachable') &&
        !body.text.includes('<!channel>')
      )
    })
  })

  it('throws on a non-2xx answer (the notifier logs it by channel name)', async () => {
    const http = new HttpClient().fake({ 'hooks.slack.com/*': { status: 500 } })
    await expect(slackChannel({ url: SLACK, http }).send(notification)).rejects.toThrow('HTTP 500')
  })
})

describe('webhookChannel', () => {
  const secret = 'x'.repeat(40)

  it('signs `<timestamp>.<body>` with HMAC-SHA256', async () => {
    const http = new HttpClient().fake({ 'ops.example.com/*': { status: 204 } })
    await webhookChannel({
      url: 'https://ops.example.com/hooks/health',
      http,
      secret,
      now: () => 1_763_460_000_000,
    }).send(notification)
    http.assertSent((request) => {
      const body = typeof request.body === 'string' ? request.body : ''
      return (
        request.headers.get('x-health-timestamp') === '1763460000' &&
        request.headers.get('x-health-signature') ===
          `sha256=${signature(secret, '1763460000', body)}` &&
        request.headers.get('content-type') === 'application/json' &&
        JSON.parse(body).event === 'health.alert'
      )
    })
  })

  it('sends unsigned without a secret, refuses a short secret', async () => {
    const http = new HttpClient().fake({ 'ops.example.com/*': { status: 200 } })
    await webhookChannel({ url: 'https://ops.example.com/h', http }).send(notification)
    http.assertSent((request) => request.headers.get('x-health-signature') === null)
    expect(
      bootMessage(() =>
        webhookChannel({ url: 'https://ops.example.com/h', http, secret: 'short' }),
      ),
    ).toContain('at least 32 characters')
  })

  it.each([
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/admin',
    'https://10.0.0.5/hook',
    'https://[::1]/hook',
  ])('the SSRF guard refuses %s', async (url) => {
    const http = new HttpClient().fake(() => ({ status: 200 }))
    await expect(webhookChannel({ url, http }).send(notification)).rejects.toMatchObject({
      code: 'ssrf_blocked',
    })
    http.assertNothingSent()
  })

  it('reaches an internal receiver only when explicitly allowed', async () => {
    const http = new HttpClient().fake(() => ({ status: 200 }))
    await webhookChannel({ url: 'https://10.0.0.5/hook', http, allow: ['10.0.0.0/8'] }).send(
      notification,
    )
    http.assertSentCount(1)
    const failing = new HttpClient().fake(() => ({ status: 502 }))
    await expect(
      webhookChannel({ url: 'https://ops.example.com/h', http: failing }).send(notification),
    ).rejects.toThrow('HTTP 502')
  })
})

describe('mailChannel', () => {
  it('sends through the given transport, one-line subject (no header injection)', async () => {
    const sent: { to: readonly string[]; subject: string; text: string }[] = []
    const channel = mailChannel({
      to: ['ops@example.com'],
      send: async (mail) => void sent.push(mail),
    })
    await channel.send({ ...notification, subject: 'Health\r\nBcc: victim@example.com' })
    expect(sent[0]).toEqual({
      to: ['ops@example.com'],
      subject: 'Health Bcc: victim@example.com',
      text: notification.text,
    })
  })

  it('refuses no recipients and invalid addresses', () => {
    expect(bootMessage(() => mailChannel({ to: [], send: async () => undefined }))).toContain(
      'at least one recipient',
    )
    expect(
      bootMessage(() =>
        mailChannel({ to: ['ops@example.com\r\nBcc: x@y.z'], send: async () => undefined }),
      ),
    ).toContain('is not an e-mail address')
  })
})
