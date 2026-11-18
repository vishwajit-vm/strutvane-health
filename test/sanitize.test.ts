/**
 * Security: nothing secret leaves the runner. Every class of leak gets a test: known env secrets,
 * credentials in URLs, bearer tokens, key=value pairs, sensitive meta keys, control characters
 * (log/terminal forging) and unbounded sizes.
 */
import { randomBytes } from 'node:crypto'
import { REDACTED } from '@strutvane/framework/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Result } from '../src/result.ts'
import {
  MAX_MESSAGE_LENGTH,
  MAX_META_ENTRIES,
  MAX_SUMMARY_LENGTH,
  sanitizeMeta,
  sanitizeResult,
  sanitizeText,
  secretValues,
} from '../src/sanitize.ts'

const password = randomBytes(12).toString('hex')
const appKey = `base64:${randomBytes(32).toString('base64')}`
const env = {
  APP_NAME: 'Blog',
  APP_ENV: 'production',
  DB_PASSWORD: password,
  APP_KEY: appKey,
  HEALTH_CHECK_TOKEN: randomBytes(32).toString('base64url'),
  STRIPE_SECRET: randomBytes(16).toString('hex'),
  SHORT_TOKEN: 'abc',
  DATABASE_URL: `postgres://app:${password}x@db.internal:5432/app`,
  UNDEFINED_SECRET: undefined,
}

describe('secretValues', () => {
  it('collects values of sensitive names and credentialed URLs, longest first', () => {
    const secrets = secretValues(env)
    expect(secrets).toContain(password)
    expect(secrets).toContain(appKey)
    expect(secrets).toContain(appKey.slice('base64:'.length))
    expect(secrets).toContain(env.HEALTH_CHECK_TOKEN)
    expect(secrets).toContain(env.STRIPE_SECRET)
    expect(secrets).toContain(env.DATABASE_URL)
    expect(secrets).not.toContain('Blog')
    expect(secrets).not.toContain('production')
    expect(secrets).not.toContain('abc')
    const lengths = secrets.map((secret) => secret.length)
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths)
  })
})

describe('sanitizeText', () => {
  const secrets = secretValues(env)

  it('masks every known secret value, wherever it appears', () => {
    const text = `auth failed for ${password} (key ${appKey}) token=${env.HEALTH_CHECK_TOKEN}`
    const out = sanitizeText(text, secrets, 1000)
    expect(out).not.toContain(password)
    expect(out).not.toContain(appKey.slice(7))
    expect(out).not.toContain(env.HEALTH_CHECK_TOKEN)
    expect(out).toContain(REDACTED)
  })

  it('masks credentials in any URL, even unknown ones', () => {
    expect(sanitizeText('connect mysql://root:hunter2@10.0.0.5/app', [], 200)).toBe(
      `connect mysql://${REDACTED}@10.0.0.5/app`,
    )
    expect(sanitizeText('GET https://ghp_tokenvalue@github.com/x', [], 200)).toBe(
      `GET https://${REDACTED}@github.com/x`,
    )
    expect(sanitizeText('see https://example.com/path', [], 200)).toBe(
      'see https://example.com/path',
    )
  })

  it('masks bearer tokens and key=value secrets in free text', () => {
    expect(sanitizeText('sent Authorization: Bearer abcdef123456', [], 200)).toBe(
      `sent Authorization: Bearer ${REDACTED}`,
    )
    expect(sanitizeText('password=hunter2 user=bob', [], 200)).toBe(`password=${REDACTED} user=bob`)
    expect(sanitizeText('{"api_key":"sk_live_1"}', [], 200)).toBe(`{"api_key":"${REDACTED}"}`)
    expect(sanitizeText('client_secret: s3cr3t', [], 200)).toBe(`client_secret: ${REDACTED}`)
  })

  it('strips control characters (no forged log lines or terminal escapes) but keeps newlines', () => {
    const out = sanitizeText('ok\u001b[31m red\r\nnext\u0000\u0085line\tend', [], 200)
    expect(out).toBe('ok[31m red\nnextline\tend')
  })

  it('bounds the length', () => {
    const out = sanitizeText('x'.repeat(5000), [], 100)
    expect(out).toHaveLength(100)
    expect(out.endsWith('…')).toBe(true)
  })

  it('property: a secret embedded anywhere in any text never survives', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.stringMatching(/^[A-Za-z0-9]{8,40}$/),
        (before, after, secret) => {
          const out = sanitizeText(`${before}${secret}${after}`, [secret], 10_000)
          return !out.includes(secret)
        },
      ),
    )
  })
})

describe('sanitizeMeta', () => {
  it('drops sensitive keys, masks string values, nulls non-finite numbers, drops objects', () => {
    const meta = sanitizeMeta(
      {
        latencyMs: 3,
        password: 'x',
        apiKey: 'y',
        authorization: 'z',
        DB_PASSWORD: 'w',
        url: `postgres://u:${password}@h/db`,
        ratio: Number.NaN,
        ok: true,
        none: null,
        nested: { a: 1 } as unknown as string,
      },
      secretValues(env),
    )
    expect(meta).toEqual({
      latencyMs: 3,
      url: `postgres://${REDACTED}@h/db`,
      ratio: null,
      ok: true,
      none: null,
    })
  })

  it('keeps at most MAX_META_ENTRIES entries', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(sanitizeMeta(many, []))).toHaveLength(MAX_META_ENTRIES)
  })
})

describe('sanitizeResult', () => {
  it('sanitizes and bounds summary and message, keeps the status', () => {
    const result = sanitizeResult(
      Result.failed('x'.repeat(500), `password=${password} ${'y'.repeat(5000)}`, { token: 't' }),
      [password],
    )
    expect(result.status).toBe('failed')
    expect(result.summary).toHaveLength(MAX_SUMMARY_LENGTH)
    expect(result.message).toHaveLength(MAX_MESSAGE_LENGTH)
    expect(result.message).not.toContain(password)
    expect(result.meta).toEqual({})
    expect(sanitizeResult(Result.ok('fine'), [])).toEqual({
      status: 'ok',
      summary: 'fine',
      meta: {},
    })
  })
})
