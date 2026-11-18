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
 *    URL with credentials) are replaced wherever they appear, in any text.
 * 2. **Credentials in URLs** (`postgres://user:pass@host`) are masked even when the value is not
 *    in the environment.
 * 3. **Bearer tokens and `key=value` secrets** in free text are masked.
 * 4. **Meta keys** whose name looks sensitive (`password`, `apiKey`, `authorization`…) are dropped,
 *    using the framework logger's own sensitive-key matcher, so health and logs agree.
 * 5. Control characters are stripped and text is bounded, so output can't forge log lines or
 *    terminal escapes, and one huge message can't fill the history table.
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
/** `scheme://user:pass@` or `scheme://token@`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*(?::[^\s/@]*)?@/gi
/** `Bearer abc…`, `Basic abc…`. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi
/** `password=…`, `api_key: …`, `"token":"…"` in free text. */
const KEY_VALUE =
  /\b([A-Za-z_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z_-]*)("?\s*[:=]\s*"?)([^\s"',;&]+)/gi

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
 * Mask secrets in a piece of text and bound its length.
 *
 * @example
 * sanitizeText('connect postgres://app:s3cret@db/app failed', [], 200)
 * // 'connect postgres://[REDACTED]@db/app failed'
 */
export function sanitizeText(text: string, secrets: readonly string[], maxLength: number): string {
  let out = withoutControls(text)
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  out = out
    .replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KEY_VALUE, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
  return out.length > maxLength ? `${out.slice(0, Math.max(0, maxLength - 1))}…` : out
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
