/**
 * `GET /health.json`: the health report for monitors and dashboards. **Never public by default.**
 *
 * `/up` (the framework's own route) stays the public liveness probe: it says "the process
 * answers" and nothing else. This endpoint says much more (which dependencies are down, how full
 * the disk is), which helps an attacker as much as an operator, so every request must prove it
 * may read it:
 *
 * - **A token**, `HEALTH_CHECK_TOKEN`, sent as `Authorization: Bearer <token>` (or
 *   `X-Health-Token`). Never in the query string: URLs end up in access logs, proxies and browser
 *   history. Compared in constant time (SHA-256 digests with `timingSafeEqual`), so response
 *   timing can't reveal it character by character.
 * - **Or your policy**: `app.make(HealthToken).authorizeUsing((ctx) => ...)`, for example signed-in
 *   admins. A policy that throws denies.
 * - **Neither configured:** the endpoint answers `404`, exactly like a route that does not exist.
 *
 * Failed attempts are counted per client IP in the cache; after `max_failed_attempts` in a minute
 * the endpoint answers `429` (also to correct tokens from that IP, until the minute passes), so
 * guessing the token is pointless even before the `api` group's own rate limit.
 *
 * What the response contains: overall status, and per check its name, label, status, summary and
 * duration. Messages only with `endpoint.expose_messages`; meta never. Everything was sanitized by
 * the runner. The status code is `200` for ok and warning, `503` for failed, so a plain uptime
 * monitor alerts without parsing JSON. Responses are `Cache-Control: no-store`.
 *
 * Load: reports are reused for `cache_seconds` and concurrent requests share one run, so the
 * endpoint can't be used to hammer the database.
 *
 * @module
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { CacheStore, HttpContext } from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import { NotFoundError, RateLimitedError, UnauthenticatedError } from '@strutvane/framework/core'
import type { Health } from '../health.ts'
import { publicReport } from '../report.ts'

/**
 * What the endpoint handler needs.
 *
 * @example
 * healthEndpoint({ health: () => app.make(HealthToken), token, exposeMessages: false, cacheSeconds: 10, maxFailedAttempts: 10, cache: () => store, logger })
 */
export interface EndpointOptions {
  /** The service (resolved per request: the provider binds it lazily). */
  readonly health: () => Health
  /** The shared secret; empty turns token access off. */
  readonly token: string
  readonly exposeMessages: boolean
  readonly cacheSeconds: number
  readonly maxFailedAttempts: number
  /** Where failed attempts are counted; `undefined` when the app has no cache (no counting). */
  readonly cache: () => CacheStore | undefined
  readonly logger: () => Logger
}

/** Cache key prefix of the failed-attempt counters. */
export const FAILED_ATTEMPTS_PREFIX = 'health:endpoint:failed:'
const WINDOW_SECONDS = 60

/**
 * Build the endpoint's route handler.
 *
 * @example
 * Route.get('/health.json', healthEndpoint(options))
 */
export function healthEndpoint(options: EndpointOptions): (ctx: HttpContext) => Promise<Response> {
  const expected = options.token === '' ? undefined : digest(options.token)
  return async (ctx) => {
    const health = options.health()
    const authorizer = health.authorizer
    if (expected === undefined && authorizer === undefined) throw new NotFoundError()
    const cache = options.cache()
    const counterKey = `${FAILED_ATTEMPTS_PREFIX}${ctx.ip}`
    if (cache !== undefined) {
      const failures = await cache.get(counterKey).catch(() => undefined)
      if (typeof failures === 'number' && failures >= options.maxFailedAttempts)
        throw new RateLimitedError(WINDOW_SECONDS)
    }
    if (!(await allowed(ctx, expected, authorizer, options.logger))) {
      if (cache !== undefined)
        await cache.increment(counterKey, 1, WINDOW_SECONDS).catch(() => undefined)
      throw new UnauthenticatedError({
        headers: { 'www-authenticate': 'Bearer realm="health"' },
      })
    }
    const report = await health.current(options.cacheSeconds * 1000)
    return ctx.json(
      publicReport(report, { messages: options.exposeMessages }),
      report.status === 'failed' ? 503 : 200,
      { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
    )
  }
}

/**
 * The token a request presents: `Authorization: Bearer <token>`, else `X-Health-Token`. The query
 * string is ignored on purpose (see the module docs).
 *
 * @example
 * presentedToken(new Request('http://x', { headers: { authorization: 'Bearer abc' } })) // 'abc'
 */
export function presentedToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')
  if (authorization !== null) {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization)
    if (match?.[1] !== undefined) return match[1]
  }
  const header = request.headers.get('x-health-token')
  return header === null || header.trim() === '' ? undefined : header.trim()
}

async function allowed(
  ctx: HttpContext,
  expected: Buffer | undefined,
  authorizer: ((ctx: HttpContext) => boolean | Promise<boolean>) | undefined,
  logger: () => Logger,
): Promise<boolean> {
  const presented = presentedToken(ctx.request)
  // Equal-length digests: timingSafeEqual needs equal lengths, and hashing first means the
  // comparison time doesn't depend on how long the presented token is either.
  if (
    expected !== undefined &&
    presented !== undefined &&
    timingSafeEqual(digest(presented), expected)
  )
    return true
  if (authorizer === undefined) return false
  try {
    return (await authorizer(ctx)) === true
  } catch (error) {
    logger().warn('health: the endpoint policy threw; access denied', {
      error: error instanceof Error ? error.name : 'unknown',
    })
    return false
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
