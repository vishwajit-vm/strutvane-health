# @strutvane/health

## 0.2.0-next.1

### Patch Changes

- eb104e4: `GET /health.json` checks the credential first: a valid token, or a policy that allows the request, is always served. Only refused requests are counted, per client (an IPv4 address, or an IPv6 /64, with IPv4-mapped IPv6 counted as its IPv4 client), and after `max_failed_attempts` in a minute further refusals answer `429` instead of `401`.
  
  Check output masks more: the percent-encoded, JSON-escaped, base64 and base64url forms of known secret values; URL credentials up to the last `@` before the host; whole quoted values (with escapes) for keys such as `pass`, `auth`, `sig`/`signature`, `credential`, `cookie` and `session`; `Authorization`/`Cookie` header lines; Redis `AUTH` arguments; and Digest `response="…"`. Masking stays linear on long input.

## 0.2.0-next.0

### Minor Changes

- e4ed1f4: First release of `@strutvane/health`: application health checks (database reachability and
  latency, pending migrations, cache read/write, disk free space, storage writable, app key, debug
  mode in production, environment completeness, heartbeats for the queue and scheduler), results
  history in a migration-created table, ok/warning/failed thresholds, rate-limited notifications
  (Slack and webhooks through the framework's SSRF-safe HTTP client, mail through a port),
  `node strut health:check` and `health:list` with CI-friendly exit codes, a token- or
  policy-protected `GET /health.json` (never public by default; `/up` stays the public liveness
  probe), a custom checks API, and `node strut add health` installer.
