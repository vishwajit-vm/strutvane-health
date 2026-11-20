/**
 * Keeping secrets out of health output.
 *
 * Health results travel further than most data: into the history table, the JSON endpoint, CI
 * logs and Slack channels. Checks report error messages from drivers and clients, and those
 * messages sometimes carry what they should not: a connection URL with its password, an API key
 * echoed by a server, a token in a query string. So every result passes through here before it
 * leaves the runner:
 *
 * 1. **Known secret values** (from the app's environment: every variable whose *name* looks
 *    sensitive, such as `DB_PASSWORD`, `APP_KEY`, `HEALTH_CHECK_TOKEN`, plus any value that is a
 *    URL with credentials) are replaced wherever they appear, in any text, and so are the forms
 *    they take on the way: percent-encoded (`encodeURIComponent`, also with `+` for spaces and
 *    lowercase hex), JSON-escaped, base64 and base64url.
 * 2. **Credentials in URLs** (`postgres://user:pass@host`) are masked even when the value is not // trufflehog:ignore
 *    in the environment. A raw password may itself contain `@`, `/`, `:` or spaces, so the
 *    credentials run from the line's first `scheme://` to the **last** `@` on that line that is
 *    followed by a host. That can hide a little more than the credentials (an e-mail address
 *    later on the line pulls the span along); hiding a word too many is the safe way to be wrong.
 * 3. **`key=value` and `key: value` secrets** in free text, for key names containing `pass`,
 *    `pwd`, `secret`, `token`, `api_key`, `access_key`, `private_key`, `auth`, `sig`/`signature`
 *    (`X-Amz-Signature`), `credential`, `cookie` or `session`. A quoted value (`"…"` or `'…'`, with
 *    backslash escapes, as JSON writes it) is masked whole, up to its closing quote; an unquoted
 *    one up to the next whitespace.
 * 4. **Credential headers and commands:** an `Authorization`, `Proxy-Authorization`, `Cookie` or
 *    `Set-Cookie` header line is masked to its end (keeping the scheme word, such as `Bearer`);
 *    `Bearer`/`Basic`/`Token` tokens anywhere; a Digest `response="…"`; and the arguments of a
 *    Redis `AUTH` command (`AUTH <password>`, `AUTH <user> <password>`), to the end of the line.
 * 5. **Meta keys** whose name looks sensitive (`password`, `apiKey`, `authorization`…) are dropped,
 *    using the framework logger's own sensitive-key matcher, so health and logs agree.
 * 6. Control characters are stripped and text is bounded, so output can't forge log lines or
 *    terminal escapes, and one huge message can't fill the history table.
 *
 * Every rule reads the original text and marks the span it would hide; the spans are merged and
 * replaced once. So one rule never hides the context another rule needs (a password containing
 * `token="` is still inside its URL's credentials), and adding a rule can only ever hide more.
 * All patterns have bounded repetition around their keywords, so the work stays linear in the
 * length of the text.
 *
 * @module
 */
import { REDACTED, sensitiveKeyMatcher } from '@strutvane/framework/core'
import type { CheckResult, MetaValue, ResultMeta } from './result.ts'

/** Longest summary kept (characters). */
export const MAX_SUMMARY_LENGTH = 200
/** Longest message kept (characters). */
export const MAX_MESSAGE_LENGTH = 1_000
/** Most meta entries kept per result. */
export const MAX_META_ENTRIES = 32
/** Secret values shorter than this are not searched for: `"1"` would mask every digit. */
export const MIN_SECRET_LENGTH = 6

const isSensitiveKey = sensitiveKeyMatcher()

/** Env names that hold credentials even though the generic matcher may not know them. */
const SECRET_ENV_NAME =
  /(?:^|_)(?:KEY|KEYS|SECRET|TOKEN|PASSWORD|PASS|PASSPHRASE|PWD|CREDENTIALS?|PRIVATE|DSN|AUTH|COOKIE|SALT|SIGNATURE|WEBHOOK)(?:_|$)/i

/** A double- or single-quoted value with backslash escapes; an unterminated one runs to the line end. */
const QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`
/** The scheme word of an `Authorization` value, kept in the output. */
const SCHEME_WORD = '(?:bearer|basic|digest|token|negotiate|ntlm|aws4-hmac-sha256)'
/**
 * `password=…`, `api_key: …`, `"token":"…"`, `X-Amz-Signature=…`, `authorization: Bearer …`:
 * group 1 is the value, after any scheme word. The `{0,40}` bounds around the keyword keep
 * matching linear on long input.
 */
const KEY_VALUE = new RegExp(
  String.raw`\b[A-Za-z0-9_-]{0,40}(?:pass|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|sig|credential|cookie|session)[A-Za-z0-9_-]{0,40}["']?[ \t]{0,8}[:=][ \t]{0,8}(?:${SCHEME_WORD}[ \t]+)?(${QUOTED}|\S+)`,
  'gi',
)
/** An `Authorization`/`Cookie` header line: group 1 or 2 is its value after any scheme word. */
const CREDENTIAL_HEADER = new RegExp(
  String.raw`\b(?:proxy-)?authorization[ \t]{0,8}:[ \t]{0,8}(?:${SCHEME_WORD}[ \t]+)?([^\n]+)|\b(?:set-)?cookie[ \t]{0,8}:[ \t]{0,8}([^\n]+)`,
  'gi',
)
/** `Bearer abc…`, `Basic abc…`, `Token abc…` anywhere: group 1 is the token. */
const AUTH_SCHEME = /\b(?:Bearer|Basic|Token)[ \t]+([A-Za-z0-9._~+/=-]{6,})/gi
/** A Digest `response="…"`: group 1 is the quoted value. */
const DIGEST_RESPONSE = new RegExp(String.raw`\bresponse[ \t]{0,8}=[ \t]{0,8}(${QUOTED})`, 'gi')
/**
 * A Redis `AUTH` command (`AUTH pw`, `AUTH user pw`, `["AUTH","user","pw"]`): group 1 is its
 * arguments, to the line end. Upper case only, as Redis and its clients write the command, so the
 * word "auth" in a sentence is left alone.
 */
const REDIS_AUTH = /\bAUTH\b["']?[ \t,]+([^\n]+)/g
/** `scheme://`, with a bounded scheme length. */
const URL_SCHEME = /\b[a-z][a-z0-9+.-]{0,30}:\/\//i
/** The first character of a host: what follows the `@` that ends a URL's credentials. */
const HOST_START = /[A-Za-z0-9[]/

/** A half-open span `[start, end)` of the text to hide. */
type Span = readonly [start: number, end: number]

/**
 * The secret values to search for in output: values of env variables whose name looks sensitive,
 * and values that embed credentials. Longest first, so a secret that contains another is masked
 * whole.
 *
 * @example
 * secretValues({ DB_PASSWORD: 'hunter2hunter2', APP_NAME: 'Blog' }) // ['hunter2hunter2']
 */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const found = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    const trimmed = value.trim()
    if (trimmed.length < MIN_SECRET_LENGTH) continue
    const sensitive =
      SECRET_ENV_NAME.test(name) || isSensitiveKey(name) || /:\/\/[^\s/@]+@/.test(trimmed)
    if (!sensitive) continue
    found.add(trimmed)
    // `base64:…` keys are also used without their prefix.
    if (trimmed.startsWith('base64:') && trimmed.length - 7 >= MIN_SECRET_LENGTH)
      found.add(trimmed.slice(7))
  }
  return [...found].sort((a, b) => b.length - a.length)
}

/**
 * Every form a known secret is likely to take in a message: as it is, percent-encoded (as
 * `encodeURIComponent` writes it, with `+` for spaces as forms write it, and with lowercase hex),
 * JSON-escaped (also with `\/`), base64 (padded and not) and base64url.
 *
 * @example
 * secretForms(['p@ss word']) // ['p@ss word', 'p%40ss%20word', 'p%40ss+word', 'cEBzcyB3b3Jk', …]
 */
export function secretForms(secrets: readonly string[]): readonly string[] {
  const cached = formsCache.get(secrets)
  if (cached !== undefined) return cached
  const forms = new Set<string>()
  for (const secret of secrets) {
    forms.add(secret)
    const encoded = encodeURIComponent(secret)
    forms.add(encoded)
    forms.add(encoded.replaceAll('%20', '+'))
    forms.add(encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()))
    const json = JSON.stringify(secret).slice(1, -1)
    forms.add(json)
    forms.add(json.replaceAll('/', '\\/'))
    const base64 = Buffer.from(secret, 'utf8').toString('base64')
    forms.add(base64)
    forms.add(base64.replace(/=+$/, ''))
    forms.add(Buffer.from(secret, 'utf8').toString('base64url'))
  }
  const sorted = [...forms]
    .filter((form) => form.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  formsCache.set(secrets, sorted)
  return sorted
}

/** The secret lists come from a long-lived service, so their forms are worked out once. */
const formsCache = new WeakMap<readonly string[], readonly string[]>()

/**
 * Mask secrets in a piece of text and bound its length.
 *
 * @example
 * sanitizeText('connect postgres://app:s3cret@db/app failed', [], 200) // trufflehog:ignore
 * // 'connect postgres://[REDACTED]@db/app failed'
 */
export function sanitizeText(text: string, secrets: readonly string[], maxLength: number): string {
  const clean = withoutControls(text)
  const spans: Span[] = [
    ...knownSecretSpans(clean, secretForms(secrets)),
    ...urlCredentialSpans(clean),
    ...groupSpans(clean, KEY_VALUE, quotedInside),
    ...groupSpans(clean, CREDENTIAL_HEADER),
    ...groupSpans(clean, AUTH_SCHEME),
    ...groupSpans(clean, DIGEST_RESPONSE, quotedInside),
    ...groupSpans(clean, REDIS_AUTH),
  ]
  const out = masked(clean, spans)
  return out.length > maxLength ? `${out.slice(0, Math.max(0, maxLength - 1))}…` : out
}

/** Every occurrence of every known form. */
function knownSecretSpans(text: string, forms: readonly string[]): Span[] {
  const spans: Span[] = []
  for (const form of forms) {
    let at = text.indexOf(form)
    while (at !== -1) {
      spans.push([at, at + form.length])
      at = text.indexOf(form, at + 1)
    }
  }
  return spans
}

/**
 * Per line: from the end of the first `scheme://` to the last `@` that is followed by a host
 * (see the module docs for why the last one). One backwards scan and one forward search per line.
 */
function urlCredentialSpans(text: string): Span[] {
  const spans: Span[] = []
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    let at = -1
    for (let index = lineEnd - 2; index >= lineStart; index -= 1)
      if (text[index] === '@' && HOST_START.test(text[index + 1] ?? '')) {
        at = index
        break
      }
    if (at !== -1) {
      const scheme = URL_SCHEME.exec(text.slice(lineStart, at))
      if (scheme !== null) {
        const start = lineStart + scheme.index + scheme[0].length
        if (start < at) spans.push([start, at])
      }
    }
    lineStart = lineEnd + 1
  }
  return spans
}

/**
 * The span of each match's first participating capture group. `adjust` may narrow it (to the
 * inside of quotes) or widen it past the match (see {@link quotedInside}); it gets the index just
 * after the match.
 */
function groupSpans(
  text: string,
  pattern: RegExp,
  adjust?: (value: string, text: string, after: number) => Span,
): Span[] {
  const spans: Span[] = []
  for (const match of text.matchAll(pattern)) {
    const value = match.slice(1).find((group) => group !== undefined)
    if (value === undefined || value === '') continue
    const after = match.index + match[0].length
    const start = after - value.length
    const [from, to] = adjust === undefined ? [0, value.length] : adjust(value, text, after)
    if (to > from) spans.push([start + from, start + to])
  }
  return spans
}

/** What may follow a closing quote when the quotes really delimited the value. */
const AFTER_QUOTED = /[\s,;}\]&]/

/**
 * For a quoted value, the part between the quotes, so the output keeps its shape
 * (`"[REDACTED]"`). When the "closing" quote is followed by more of the same word
 * (`password=''x%40y`), the quotes did not delimit the value: the span runs on to the next
 * whitespace, like an unquoted value.
 */
function quotedInside(value: string, text: string, after: number): Span {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return [0, value.length]
  const closed = value.length >= 2 && value.endsWith(quote) && !isEscaped(value, value.length - 1)
  if (!closed) return [1, value.length]
  const next = text[after]
  if (next === undefined || AFTER_QUOTED.test(next)) return [1, value.length - 1]
  let end = after
  while (end < text.length && !/\s/.test(text[end] ?? ' ')) end += 1
  return [1, value.length + (end - after)]
}

/** `true` when the character at `index` follows an odd number of backslashes. */
function isEscaped(value: string, index: number): boolean {
  let slashes = 0
  for (let at = index - 1; at >= 0 && value[at] === '\\'; at -= 1) slashes += 1
  return slashes % 2 === 1
}

/** Replace the union of the spans (overlapping or touching spans merge) with `REDACTED`. */
function masked(text: string, spans: Span[]): string {
  if (spans.length === 0) return text
  spans.sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  let current: [number, number] | undefined
  for (const [start, end] of spans) {
    if (current !== undefined && start <= current[1]) {
      current[1] = Math.max(current[1], end)
      continue
    }
    if (current !== undefined) {
      out += text.slice(cursor, current[0]) + REDACTED
      cursor = current[1]
    }
    current = [start, end]
  }
  if (current !== undefined) {
    out += text.slice(cursor, current[0]) + REDACTED
    cursor = current[1]
  }
  return out + text.slice(cursor)
}

/**
 * Drop sensitive meta keys, mask secrets in string values and bound the entry count. Non-finite
 * numbers become `null` (JSON has no `NaN`).
 *
 * @example
 * sanitizeMeta({ latencyMs: 3, password: 'x' }, []) // { latencyMs: 3 }
 */
export function sanitizeMeta(meta: ResultMeta, secrets: readonly string[]): ResultMeta {
  const out: Record<string, MetaValue> = {}
  let count = 0
  for (const [key, value] of Object.entries(meta)) {
    if (count >= MAX_META_ENTRIES) break
    if (isSensitiveKey(key) || SECRET_ENV_NAME.test(key)) continue
    const safeKey = sanitizeText(key, secrets, 64)
    if (typeof value === 'string') out[safeKey] = sanitizeText(value, secrets, MAX_MESSAGE_LENGTH)
    else if (typeof value === 'number') out[safeKey] = Number.isFinite(value) ? value : null
    else if (typeof value === 'boolean' || value === null) out[safeKey] = value
    else continue
    count += 1
  }
  return out
}

/**
 * A result with every text field masked and bounded (see the module docs).
 *
 * @example
 * sanitizeResult(Result.failed('down', 'password=hunter2'), []).message // 'password=[REDACTED]'
 */
export function sanitizeResult(result: CheckResult, secrets: readonly string[]): CheckResult {
  const summary = sanitizeText(result.summary, secrets, MAX_SUMMARY_LENGTH)
  const meta = sanitizeMeta(result.meta, secrets)
  return result.message === undefined
    ? { status: result.status, summary, meta }
    : {
        status: result.status,
        summary,
        message: sanitizeText(result.message, secrets, MAX_MESSAGE_LENGTH),
        meta,
      }
}

/** Drop C0/C1 control characters except tab and newline (ANSI escapes start with one). */
function withoutControls(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
    if (!control) out += char
  }
  return out
}
