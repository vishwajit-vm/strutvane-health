/**
 * The whole class of "a secret leaves in a format the sanitizer did not expect": secrets drawn
 * from the full printable alphabet (including `@ / " ' , ; \` and spaces), written the way real
 * drivers, clients and loggers write them, must never leave a run of 6 characters behind. Two
 * halves: secrets nobody told the sanitizer about (every carrier), and known secrets in every
 * encoded form.
 */
import { REDACTED } from '@strutvane/framework/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  MAX_MESSAGE_LENGTH,
  MIN_SECRET_LENGTH,
  sanitizeText,
  secretForms,
} from '../src/sanitize.ts'

/** Every run of 6 characters in `value` (the shortest piece that could identify a secret). */
function sixes(value: string): string[] {
  const out: string[] = []
  for (let at = 0; at + MIN_SECRET_LENGTH <= value.length; at += 1)
    out.push(value.slice(at, at + MIN_SECRET_LENGTH))
  return out
}

/** Printable ASCII, with the characters that end or split values in real formats drawn often. */
const printable = fc.oneof(
  fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
  fc.constantFrom('@', '/', '"', "'", ',', ';', ' ', '\\', ':', '=', '%', '&', '#', '?'),
)
const anySecret = fc.string({ unit: printable, minLength: 8, maxLength: 40 })

/** A value in double quotes, escaped as JSON and most loggers write it. */
const dq = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
/** A value in single quotes with backslash escapes. */
const sq = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
/** logfmt: bare when it is one safe word, quoted otherwise. */
const logfmt = (value: string): string => (/[\s"'\\=]/.test(value) ? dq(value) : value)
const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

const SECRET_KEYS = [
  'password',
  'pass',
  'DB_PASS',
  'pwd',
  'auth',
  'sig',
  'signature',
  'X-Amz-Signature',
  'credential',
  'credentials',
  'cookie',
  'session',
  'session_id',
  'token',
  'api_key',
  'client_secret',
  'private_key',
] as const

interface Carried {
  readonly text: string
  /** The form of the secret that ends up in the text. */
  readonly form: string
}

/** Each carrier writes a secret the way a driver, client or logger would. */
const CARRIERS: readonly {
  readonly name: string
  readonly write: (secret: string, key: string) => Carried
}[] = [
  {
    name: 'URL userinfo password, raw',
    write: (s) => ({ text: `connect postgres://app:${s}@db.internal:5432/app failed`, form: s }),
  },
  {
    name: 'URL userinfo user, raw',
    write: (s) => ({ text: `connect redis://${s}:x@cache.internal:6379/0 refused`, form: s }),
  },
  {
    name: 'URL userinfo token, raw',
    write: (s) => ({ text: `GET https://${s}@api.example.com/v1/status 401`, form: s }),
  },
  {
    name: 'URL userinfo, percent-encoded',
    write: (s) => {
      const form = encodeURIComponent(s)
      return { text: `connect mysql://app:${form}@[2001:db8::5]:3306/app failed`, form }
    },
  },
  {
    name: 'key="value"',
    write: (s, key) => ({ text: `request failed: ${key}=${dq(s)} user="bob"`, form: dq(s) }),
  },
  {
    name: "key='value'",
    write: (s, key) => ({ text: `request failed: ${key}=${sq(s)} user='bob'`, form: sq(s) }),
  },
  {
    name: 'key=value (logfmt)',
    write: (s, key) => ({ text: `level=error ${key}=${logfmt(s)} user=bob`, form: logfmt(s) }),
  },
  {
    name: 'key: value (logfmt)',
    write: (s, key) => ({ text: `upstream said ${key}: ${logfmt(s)}`, form: logfmt(s) }),
  },
  {
    name: 'a query string',
    write: (s, key) => {
      const form = encodeURIComponent(s)
      return { text: `GET /callback?state=1&${key}=${form}&next=2 HTTP/1.1`, form }
    },
  },
  {
    name: 'JSON',
    write: (s, key) => {
      const form = JSON.stringify(s)
      return { text: `body {"user":"bob",${JSON.stringify(key)}:${form},"n":1}`, form }
    },
  },
  {
    name: 'an Authorization: Bearer header',
    write: (s) => ({ text: `sent\nAuthorization: Bearer ${s}\nAccept: */*`, form: s }),
  },
  {
    name: 'a Proxy-Authorization: Basic header',
    write: (s) => {
      const form = b64(`app:${s}`)
      return { text: `sent\nProxy-Authorization: Basic ${form}\nAccept: */*`, form }
    },
  },
  {
    name: 'an Authorization: Digest header',
    write: (s) => ({
      text: `sent\nAuthorization: Digest username="app", realm="api", response=${dq(s)}`,
      form: dq(s),
    }),
  },
  {
    name: 'a Digest response="…" in free text',
    write: (s) => ({
      text: `digest username="app", nonce="abc", response=${dq(s)}, qop=auth`,
      form: dq(s),
    }),
  },
  {
    name: 'a Cookie header',
    write: (s) => ({ text: `sent\nCookie: theme=dark; sid=${s}\n`, form: s }),
  },
  {
    name: 'Redis AUTH <password>',
    write: (s) => ({ text: `ERR AUTH ${s} called without any password configured`, form: s }),
  },
  {
    name: 'Redis AUTH <user> <password>',
    write: (s) => ({ text: `command failed: AUTH app ${s}`, form: s }),
  },
  {
    name: 'Redis AUTH as an argument list',
    write: (s) => {
      const form = JSON.stringify(s)
      return { text: `command ["AUTH","app",${form}] failed`, form }
    },
  },
]

describe('sanitizeText: secrets nobody told it about', () => {
  for (const carrier of CARRIERS) {
    it(`property: no 6 characters of an unknown secret survive in ${carrier.name}`, () => {
      fc.assert(
        fc.property(anySecret, fc.constantFrom(...SECRET_KEYS), (secret, key) => {
          const { text, form } = carrier.write(secret, key)
          // Pieces the carrier itself always contains are not evidence of a leak.
          const background = [
            carrier.write('', key).text,
            carrier.write(REDACTED, key).text,
            REDACTED,
            'check failed',
            'retrying in 5s',
          ].join('\n')
          const pieces = [...new Set([...sixes(secret), ...sixes(form)])]
          fc.pre(pieces.every((piece) => !background.includes(piece)))
          const out = sanitizeText(`check failed\n${text}\nretrying in 5s`, [], 10_000)
          expect(
            pieces.filter((piece) => out.includes(piece)),
            out,
          ).toEqual([])
        }),
        { numRuns: 300 },
      )
    })
  }
})

describe('sanitizeText: the forms a known secret takes', () => {
  const forms: readonly (readonly [string, (secret: string) => string])[] = [
    ['raw', (s) => s],
    ['encodeURIComponent', (s) => encodeURIComponent(s)],
    ['form encoding', (s) => encodeURIComponent(s).replaceAll('%20', '+')],
    [
      'lowercase percent-encoding',
      (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    ],
    ['JSON escaping', (s) => JSON.stringify(s).slice(1, -1)],
    ['JSON escaping with \\/', (s) => JSON.stringify(s).slice(1, -1).replaceAll('/', '\\/')],
    ['base64', (s) => b64(s)],
    ['base64 without padding', (s) => b64(s).replace(/=+$/, '')],
    ['base64url', (s) => Buffer.from(s, 'utf8').toString('base64url')],
  ]
  for (const [name, encode] of forms) {
    it(`property: a known secret never survives ${name}`, () => {
      fc.assert(
        fc.property(anySecret, (secret) => {
          const form = encode(secret)
          const background = `value was  in the response\n${REDACTED}`
          const pieces = sixes(form)
          fc.pre(pieces.every((piece) => !background.includes(piece)))
          const out = sanitizeText(`value was ${form} in the response`, [secret], 10_000)
          expect(
            pieces.filter((piece) => out.includes(piece)),
            out,
          ).toEqual([])
        }),
        { numRuns: 200 },
      )
    })
  }

  it('secretForms lists each form once, longest first, without forms under the minimum', () => {
    const forms = secretForms(['p@ss word'])
    expect(forms).toContain('p@ss word')
    expect(forms).toContain('p%40ss%20word')
    expect(forms).toContain('p%40ss+word')
    expect(forms).toContain(b64('p@ss word'))
    expect(new Set(forms).size).toBe(forms.length)
    const lengths = forms.map((form) => form.length)
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths)
    expect(secretForms(['ab'])).toEqual([])
    const list = ['same-list-instance']
    expect(secretForms(list)).toBe(secretForms(list))
  })
})

describe('sanitizeText: shapes and edges', () => {
  it('keeps the quotes of a quoted value and the scheme word of a header', () => {
    expect(sanitizeText('{"session":"a\\"b c","user":"bob"}', [], 200)).toBe(
      `{"session":"${REDACTED}","user":"bob"}`,
    )
    expect(sanitizeText("X-Amz-Signature='abc def'", [], 200)).toBe(`X-Amz-Signature='${REDACTED}'`)
    expect(sanitizeText('Authorization: Bearer a b c', [], 200)).toBe(
      `Authorization: Bearer ${REDACTED}`,
    )
    expect(sanitizeText('password="never closed', [], 200)).toBe(`password="${REDACTED}`)
  })

  it('takes URL credentials to the last @ before the host; URLs without one are left alone', () => {
    expect(sanitizeText('connect postgres://app:p@ss/w rd@db/app failed', [], 200)).toBe(
      `connect postgres://${REDACTED}@db/app failed`,
    )
    expect(sanitizeText('see https://example.com/a@ and more', [], 200)).toBe(
      'see https://example.com/a@ and more',
    )
    expect(sanitizeText('line one https://example.com\nmail ops@example.com', [], 200)).toBe(
      'line one https://example.com\nmail ops@example.com',
    )
  })

  it('finds a secret key inside the value of another key', () => {
    expect(sanitizeText('user=password=abcdef rest', [], 200)).toBe(
      `user=password=${REDACTED} rest`,
    )
  })

  it('leaves the word "auth" in a sentence and an ordinary response code alone', () => {
    expect(sanitizeText('auth failed for user bob', [], 200)).toBe('auth failed for user bob')
    expect(sanitizeText('response=200 in 3ms', [], 200)).toBe('response=200 in 3ms')
  })

  it('stays fast on long, repetitive input', () => {
    const started = performance.now()
    for (const unit of [
      'a-sig-',
      'token="',
      'token="a"b',
      'response="a"b',
      "pass='\\'x",
      'x://',
      'AUTH ',
      '@a',
      'Bearer ',
      '\\"',
      'a@',
    ])
      sanitizeText(unit.repeat(20_000), ['secret-value'], MAX_MESSAGE_LENGTH)
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
