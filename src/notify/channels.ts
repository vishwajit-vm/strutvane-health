/**
 * Notification channels: where alerts go.
 *
 * - {@link slackChannel}: a Slack incoming webhook.
 * - {@link webhookChannel}: any HTTPS endpoint, with an optional HMAC signature so the receiver
 *   can tell the alert is genuine.
 * - {@link mailChannel}: mail through a `send` function you provide (the framework's mailer is
 *   not released yet; until it is, wire your own transport).
 *
 * **SSRF and secrets.** HTTP channels send through the framework's `HttpClient`, whose SSRF guard
 * is always on: private, loopback and metadata addresses are refused even if a webhook URL (or a
 * DNS answer, or a redirect) points there. URLs must be `https:`; the Slack channel also pins the
 * host to `hooks.slack.com`. Webhook URLs are secrets (whoever has one can post), so they are
 * never logged or echoed: errors name the channel, not the URL.
 *
 * @module
 */
import { createHmac } from 'node:crypto'
import type { HttpClient } from '@strutvane/framework'
import { BootError } from '@strutvane/framework'

/**
 * What a channel is asked to deliver.
 *
 * @example
 * const notification: HealthNotification = { subject: '[Blog] health: failed', text: '…', status: 'failed', checks: [] }
 */
export interface HealthNotification {
  /** One line: `[Blog, production] Health: failed (database, disk-space)`. */
  readonly subject: string
  /** The full message: one line per check that changed. */
  readonly text: string
  /** The overall status the alert is about (`ok` for a recovery). */
  readonly status: 'ok' | 'warning' | 'failed'
  /** The checks the alert is about (sanitized). */
  readonly checks: readonly {
    readonly name: string
    readonly label: string
    readonly status: string
    readonly summary: string
  }[]
}

/**
 * A place alerts go.
 *
 * @example
 * const channel: NotificationChannel = { name: 'log', send: async (n) => logger.warn(n.subject) }
 */
export interface NotificationChannel {
  /** Shown in logs when delivery fails (never the URL). */
  readonly name: string
  send(notification: HealthNotification): Promise<void>
}

/** Per-request limits for alert delivery: an alert must never hang a health run. */
const SEND_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * Parse and vet a webhook URL: `https:` only (plain `http:` would send the alert, and the URL's
 * secret path, in clear text), no credentials in it, and optionally a fixed host.
 *
 * @example
 * webhookUrl('https://hooks.slack.com/services/T/B/x', 'slackChannel', 'hooks.slack.com')
 */
export function webhookUrl(value: string, factory: string, host?: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw channelError(factory, 'the URL is not valid')
  }
  if (url.protocol !== 'https:') throw channelError(factory, 'the URL must start with https://')
  if (url.username !== '' || url.password !== '')
    throw channelError(factory, 'the URL must not contain a user name or password')
  if (host !== undefined && url.hostname !== host)
    throw channelError(factory, `the URL must point at ${host}`)
  return url
}

function channelError(factory: string, problem: string): BootError {
  // The URL itself is a secret: the message never includes it.
  return new BootError(
    'invalid_health_channel',
    `${factory}(): ${problem}.`,
    'Fix the webhook URL in the environment (HEALTH_SLACK_WEBHOOK_URL / HEALTH_WEBHOOK_URL).',
  )
}

/**
 * Options of {@link slackChannel}.
 *
 * @example
 * const options: SlackChannelOptions = { url: env.HEALTH_SLACK_WEBHOOK_URL, http }
 */
export interface SlackChannelOptions {
  /** The incoming-webhook URL (`https://hooks.slack.com/services/…`). */
  readonly url: string
  /** The framework's HTTP client (`app.make(HttpClientToken)`), SSRF guard included. */
  readonly http: HttpClient
}

/**
 * Post alerts to a Slack incoming webhook.
 *
 * @example
 * slackChannel({ url: process.env.HEALTH_SLACK_WEBHOOK_URL ?? '', http: app.make(HttpClientToken) })
 */
export function slackChannel(options: SlackChannelOptions): NotificationChannel {
  const url = webhookUrl(options.url, 'slackChannel', 'hooks.slack.com').href
  return {
    name: 'slack',
    async send(notification) {
      const response = await options.http
        .timeout(SEND_TIMEOUT_MS)
        .maxBytes(MAX_RESPONSE_BYTES)
        .maxRedirects(0)
        .post(url, {
          text: `*${escapeSlack(notification.subject)}*\n${escapeSlack(notification.text)}`,
        })
      if (!response.ok) throw new Error(`slack answered HTTP ${response.status}`)
    },
  }
}

/** Slack treats `<`, `>` and `&` as markup: check output must not create links or mentions. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Options of {@link webhookChannel}.
 *
 * @example
 * const options: WebhookChannelOptions = { url: 'https://ops.example.com/hooks/health', http, secret }
 */
export interface WebhookChannelOptions {
  readonly url: string
  readonly http: HttpClient
  /**
   * Signs each body with HMAC-SHA256: header `x-health-signature: sha256=<hex>` over
   * `<timestamp>.<body>`, with the timestamp in `x-health-timestamp`, so a receiver can reject
   * forged and replayed alerts. At least 32 characters.
   */
  readonly secret?: string
  /** Internal hosts or ranges the receiver may live on (the SSRF guard blocks them otherwise). */
  readonly allow?: readonly string[]
  /** Clock for the signature timestamp (tests). */
  readonly now?: () => number
}

/**
 * POST alerts as JSON to an HTTPS endpoint.
 *
 * @example
 * webhookChannel({ url: 'https://ops.example.com/hooks/health', http: app.make(HttpClientToken), secret })
 */
export function webhookChannel(options: WebhookChannelOptions): NotificationChannel {
  const url = webhookUrl(options.url, 'webhookChannel').href
  if (options.secret !== undefined && options.secret.length < 32)
    throw channelError('webhookChannel', 'the signing secret must be at least 32 characters')
  const now = options.now ?? Date.now
  return {
    name: 'webhook',
    async send(notification) {
      const body = JSON.stringify({ event: 'health.alert', ...notification })
      const timestamp = String(Math.floor(now() / 1000))
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-health-timestamp': timestamp,
      }
      if (options.secret !== undefined)
        headers['x-health-signature'] = `sha256=${signature(options.secret, timestamp, body)}`
      let request = options.http
        .withHeaders(headers)
        .timeout(SEND_TIMEOUT_MS)
        .maxBytes(MAX_RESPONSE_BYTES)
        .maxRedirects(0)
      if (options.allow !== undefined && options.allow.length > 0)
        request = request.allow(options.allow)
      // A string body is sent as-is: the signature covers exactly these bytes.
      const response = await request.post(url, body)
      if (!response.ok) throw new Error(`webhook answered HTTP ${response.status}`)
    },
  }
}

/**
 * The webhook signature: hex HMAC-SHA256 of `<timestamp>.<body>`. Exported so receivers (and
 * tests) verify with the same function.
 *
 * @example
 * signature(secret, '1763460000', body) === header.slice('sha256='.length)
 */
export function signature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/**
 * A mail message for {@link mailChannel}.
 *
 * @example
 * const mail: HealthMail = { to: ['ops@example.com'], subject: '…', text: '…' }
 */
export interface HealthMail {
  readonly to: readonly string[]
  readonly subject: string
  readonly text: string
}

/**
 * Options of {@link mailChannel}.
 *
 * @example
 * const options: MailChannelOptions = { to: ['ops@example.com'], send: (mail) => mailer.send(mail) }
 */
export interface MailChannelOptions {
  readonly to: readonly string[]
  readonly send: (mail: HealthMail) => Promise<void>
}

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/

/**
 * Send alerts by mail through your own transport.
 *
 * @example
 * mailChannel({ to: ['ops@example.com'], send: (mail) => myMailer.send(mail) })
 */
export function mailChannel(options: MailChannelOptions): NotificationChannel {
  if (options.to.length === 0) throw channelError('mailChannel', 'list at least one recipient')
  const bad = options.to.find((address) => !EMAIL.test(address))
  if (bad !== undefined)
    throw new BootError(
      'invalid_health_channel',
      `mailChannel(): "${bad}" is not an e-mail address.`,
      'Fix notifications.mail_to in config/health.ts (comma-separated addresses).',
    )
  return {
    name: 'mail',
    async send(notification) {
      // Subjects are one line: a newline here would let check output inject mail headers.
      const subject = notification.subject.replace(/[\r\n]+/g, ' ')
      await options.send({ to: options.to, subject, text: notification.text })
    },
  }
}
