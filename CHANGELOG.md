# @strutvane/health

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
